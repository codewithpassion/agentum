import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { agentConnectors, connectors } from "@repo/db/schema/connectors";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  notExists,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { findAgent } from "../agents.ts";
import { authorize, ForbiddenError } from "../authz.ts";
import { buildMcpServers } from "../connectors/mcp-servers.ts";
import { ServiceError } from "../errors.ts";
import type { RunTokenClaims } from "../run-tokens.ts";
import { secretsGuidance } from "../secrets/guidance.ts";
import { RELAY_TOKEN_ENV } from "../secrets/relay.ts";
import type { SecretsService } from "../secrets.ts";
import type { Principal } from "../workspaces.ts";
import { loadRun } from "./queries.ts";
import type { MachineClaim, RunRecord } from "./types.ts";

const CLAIM_ACTION = "runs.claim";
const STARTING: RunRecord["status"][] = ["queued", "offered"];

export interface MachineClaimDeps {
  /** Appends `run.started` once the claim has won. */
  announceStarted: (run: RunRecord) => Promise<void>;
  db: Database;
  /** Lease length in milliseconds. */
  leaseMs: number;
  now: () => Date;
  /** The agent's granted secrets. Without it, no secret reaches the machine. */
  secrets?: Pick<SecretsService, "announceDelivery" | "resolveForAgent">;
  /** Mints the run token. The claim is the only caller. */
  signToken: (claims: RunTokenClaims) => Promise<string>;
}

/**
 * A machine claims a run. Everything the seam 3 predicate says is one
 * conditional write: the run is `queued` or `offered`, has no pending files,
 * belongs to an agent on this machine, that agent has no `running` run, and
 * no older run of the same session is still waiting. Two claimers racing see
 * one winner, because a single UPDATE is atomic. The token is signed before
 * the write, so a signing failure leaves the run untouched.
 */
export const claimForMachine = async (
  deps: MachineClaimDeps,
  principal: Principal,
  runId: string,
  options: { platformUrl: string }
): Promise<MachineClaim> => {
  if (principal.kind !== "machine") {
    throw new ForbiddenError(CLAIM_ACTION);
  }
  const { db } = deps;
  const run = await loadRun(db, runId, principal.workspaceId);
  if (!run) {
    throw new ServiceError("not_found", "Run not found");
  }
  authorize(principal, CLAIM_ACTION, {
    id: run.id,
    kind: "run",
    workspaceId: run.workspaceId,
  });
  const agent = await findAgent(db, {
    id: run.agentId,
    workspaceId: run.workspaceId,
  });
  if (agent?.machineId !== principal.machineId) {
    throw new ForbiddenError(CLAIM_ACTION);
  }

  const now = deps.now();
  const runToken = await deps.signToken({
    agentId: run.agentId,
    issuedAt: now.getTime(),
    runId: run.id,
    workspaceId: run.workspaceId,
  });
  // Resolved before the claim write, like the token: a secret that cannot be
  // read leaves the run untouched.
  const granted = await deps.secrets?.resolveForAgent(
    run.workspaceId,
    agent.id
  );

  const sibling = alias(runs, "sibling");
  const older = alias(runs, "older");
  const claimed = await db
    .update(runs)
    .set({
      claimedBy: principal.machineId,
      // ISO 8601, because the run token check compares it as text.
      leaseUntil: new Date(now.getTime() + deps.leaseMs).toISOString(),
      startedAt: now.toISOString(),
      status: "running",
    })
    .where(
      and(
        eq(runs.id, run.id),
        eq(runs.workspaceId, run.workspaceId),
        inArray(runs.status, STARTING),
        isNull(runs.pendingFiles),
        exists(
          db
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                eq(agents.id, runs.agentId),
                eq(agents.machineId, principal.machineId)
              )
            )
        ),
        notExists(
          db
            .select({ id: sibling.id })
            .from(sibling)
            .where(
              and(
                eq(sibling.agentId, runs.agentId),
                eq(sibling.status, "running")
              )
            )
        ),
        notExists(
          db
            .select({ id: older.id })
            .from(older)
            .where(
              and(
                eq(older.sessionId, runs.sessionId),
                inArray(older.status, STARTING),
                or(
                  lt(older.createdAt, runs.createdAt),
                  and(
                    eq(older.createdAt, runs.createdAt),
                    lt(older.id, runs.id)
                  )
                )
              )
            )
        )
      )
    )
    .returning({ id: runs.id });
  if (claimed.length === 0) {
    throw new ServiceError("conflict", "Run cannot be claimed");
  }

  const [claimedRun, [session], assigned] = await Promise.all([
    loadRun(db, run.id),
    db.select().from(sessions).where(eq(sessions.id, run.sessionId)).limit(1),
    db
      .select({ id: connectors.id, name: connectors.name })
      .from(agentConnectors)
      .innerJoin(connectors, eq(connectors.id, agentConnectors.connectorId))
      .where(
        and(
          eq(agentConnectors.agentId, run.agentId),
          eq(agentConnectors.workspaceId, run.workspaceId)
        )
      )
      .orderBy(agentConnectors.createdAt, agentConnectors.connectorId),
  ]);
  if (!(claimedRun && session)) {
    throw new ServiceError("not_found", "Run not found");
  }
  await deps.announceStarted(claimedRun);

  const env: Record<string, string> = { ...granted?.env };
  if (granted && granted.proxy.length > 0) {
    // The relay authenticates a call with the run's own token.
    env[RELAY_TOKEN_ENV] = runToken;
  }
  const guidance = granted
    ? secretsGuidance({
        base: options.platformUrl,
        env: Object.keys(granted.env),
        proxy: granted.proxy,
        surface: "machine",
      })
    : "";
  if (granted) {
    await deps.secrets?.announceDelivery(
      {
        agentId: claimedRun.agentId,
        runId: claimedRun.id,
        workspaceId: claimedRun.workspaceId,
      },
      {
        env: Object.keys(granted.env),
        proxy: granted.proxy,
        surface: "machine",
      }
    );
  }

  return {
    agent: {
      id: agent.id,
      model: agent.model,
      name: agent.name,
      runtimeConfig: agent.runtimeConfig,
      slug: agent.slug,
    },
    ...(Object.keys(env).length > 0 ? { env } : {}),
    inputFileIds: claimedRun.inputFileIds,
    instructions:
      guidance === ""
        ? agent.instructions
        : `${agent.instructions}\n\n${guidance}`,
    mcpServers: buildMcpServers({
      connectors: assigned,
      platformUrl: options.platformUrl,
      runToken,
    }),
    run: {
      agentId: claimedRun.agentId,
      id: claimedRun.id,
      inputText: claimedRun.inputText,
      sessionId: claimedRun.sessionId,
      workspaceId: claimedRun.workspaceId,
    },
    runToken,
    session: {
      id: session.id,
      runtimeMachineId: session.runtimeMachineId,
      runtimeRef: session.runtimeRef,
    },
  };
};
