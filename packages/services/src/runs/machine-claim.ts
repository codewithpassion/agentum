import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { agentConnectors, connectors } from "@repo/db/schema/connectors";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { taskFolderPath } from "@repo/db/shared";
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
import { agentPrompt } from "../agent-prompt.ts";
import { findAgent, handsToNames } from "../agents.ts";
import { authorize, ForbiddenError } from "../authz.ts";
import { buildMcpServers } from "../connectors/mcp-servers.ts";
import { ServiceError } from "../errors.ts";
import { agentGrants } from "../library/access.ts";
import { librarySyncScope } from "../library/sync-paths.ts";
import type { LibraryService } from "../library.ts";
import { askKeysOf } from "../requests/ask-keys.ts";
import type { RunTokenClaims } from "../run-tokens.ts";
import { secretsGuidance } from "../secrets/guidance.ts";
import { RELAY_TOKEN_ENV } from "../secrets/relay.ts";
import type { SecretsService } from "../secrets.ts";
import { slackGuidanceFor } from "../slack/guidance.ts";
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
  /** Lists the conflict copies the claim hands over. Without it, the claim names no library paths. */
  library?: Pick<LibraryService, "pendingConflicts">;
  now: () => Date;
  /** The agent's granted secrets. Without it, no secret reaches the machine. */
  secrets?: Pick<SecretsService, "announceDelivery" | "resolveForAgent">;
  /** Mints the run token. The claim is the only caller. */
  signToken: (claims: RunTokenClaims) => Promise<string>;
}

/** The library part of a claim, for a daemon that syncs the library. */
const claimLibrary = async (
  deps: MachineClaimDeps,
  run: { agentId: string; id: string; workspaceId: string },
  agent: { id: string; slug: string },
  options: { libraryForDaemon?: boolean; libraryLiveForDaemon?: boolean }
): Promise<MachineClaim["library"]> => {
  const live = options.libraryLiveForDaemon === true;
  if (!(deps.library && (options.libraryForDaemon === true || live))) {
    return;
  }
  const roots = librarySyncScope(
    agent.slug,
    await agentGrants(deps.db, run.workspaceId, agent.id)
  );
  const paths = roots.map((root) => root.path);
  return {
    conflicts: await deps.library.pendingConflicts(
      {
        agentId: run.agentId,
        kind: "run",
        runId: run.id,
        workspaceId: run.workspaceId,
      },
      paths
    ),
    paths,
    ...(live ? { roots, taskFolder: taskFolderPath(agent.slug, run.id) } : {}),
  };
};

/**
 * A machine claims a run. Everything the seam 3 predicate says is one
 * conditional write: the run is `queued` or `offered`, has no pending files,
 * belongs to an agent on this machine, that agent has no `running` run, and
 * no older run of the same agent is still waiting. Two claimers racing see
 * one winner, because a single UPDATE is atomic. The token is signed before
 * the write, so a signing failure leaves the run untouched.
 */
export const claimForMachine = async (
  deps: MachineClaimDeps,
  principal: Principal,
  runId: string,
  options: {
    libraryForDaemon?: boolean;
    libraryLiveForDaemon?: boolean;
    requestsForDaemon?: boolean;
    platformUrl: string;
  }
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

  // The library folders the daemon copies, and the conflict copies waiting in
  // them. Read before the claim write, like the token and the secrets.
  const library = await claimLibrary(deps, run, agent, options);

  const toolRules =
    options.requestsForDaemon === true
      ? await askKeysOf(db, { id: agent.id, workspaceId: run.workspaceId })
      : undefined;
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
                inArray(sibling.status, ["running", "waiting"])
              )
            )
        ),
        notExists(
          db
            .select({ id: older.id })
            .from(older)
            .where(
              and(
                eq(older.agentId, runs.agentId),
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
  const slack = await slackGuidanceFor(db, {
    agentId: agent.id,
    workspaceId: run.workspaceId,
  });
  const guidance = granted
    ? secretsGuidance({
        base: options.platformUrl,
        env: Object.keys(granted.env),
        proxy: granted.proxy,
        surface: "machine",
      })
    : "";
  if (granted) {
    try {
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
    } catch (error) {
      // The claim is committed: a log that failed must not fail the daemon's call.
      console.error(
        `Recording the secrets delivery for run ${claimedRun.id} failed: ${error instanceof Error ? error.name : "unknown error"}`
      );
    }
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
    instructions: [
      agentPrompt(agent, await handsToNames(db, agent)),
      guidance,
      slack,
    ]
      .filter((part) => part !== "")
      .join("\n\n"),
    ...(library ? { library } : {}),
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
    ...daemonRules(toolRules),
    session: {
      id: session.id,
      runtimeMachineId: session.runtimeMachineId,
      runtimeRef: session.runtimeRef,
    },
  };
};

const daemonRules = (toolRules: string[] | undefined) =>
  toolRules ? { toolRules } : {};
