/**
 * Grants, promote and hand-to for app artifacts (PRD R2.4, R2.9, phase 2).
 *
 * A version that asks for tools, secrets or hosts gets one `artifact_grants`
 * row per ask. A row a person made, or that the current version already holds
 * approved, is `approved`; every other row waits `pending` for a person.
 * `promote` makes a proposed version current once none of its rows is pending.
 * When some are, an agent's promote opens an approval in Needs you and
 * returns `waiting`, and the person's `decideGrant` answers that approval.
 */

import type { Database } from "@repo/db";
import {
  type ArtifactGrantRow,
  type ArtifactRow,
  approvedGrants,
  decideGrantStatement,
  findArtifact,
  findGrant,
  findVersion,
  findVersionById,
  insertGrants,
  listGrants,
  PROMOTE_TOOL_NAME,
  PROMOTE_TOOL_USE_PREFIX,
  promoteRequests,
  promoteStatements,
  rejectVersionStatement,
  setHandedToStatement,
} from "@repo/db/artifact-grants";
import type { Atomic } from "@repo/db/atomic";
import type { ArtifactGrantKind, ArtifactGrantStatus } from "@repo/db/shared";
import {
  artifactsDecideGrantInputSchema,
  artifactsHandToInputSchema,
  artifactsPromoteInputSchema,
} from "@repo/protocol/artifacts";
import { ulid } from "ulidx";
import { z } from "zod";
import { findAgent } from "../agents.ts";
import { authorize, ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import type { RequestsService } from "../requests.ts";
import { loadRun } from "../runs/queries.ts";
import type { Clock } from "../runs/types.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import {
  type DeclaredGrant,
  declaredGrants,
  parseManifest,
} from "./manifest.ts";
import {
  type ArtifactPolicyRecord,
  agentCanUpdate,
  canManage,
  canOpen,
} from "./policy.ts";

/** The `toolKey` the Needs you card shows for a promote request. */
const PROMOTE_TOOL_KEY = "harbourmaster/artifact_promote";
/** Marks a limits row (`<tool>#<json>`) among the tool grants. */
const LIMITS_SEPARATOR = "#";

/** What the grant checks need to know about a tool a version asks for. */
export interface ToolCatalog {
  /** The tool by `<serverKey>/<tool>`, or null when the workspace has no such tool. */
  lookup: (
    workspaceId: string,
    toolKey: string
  ) => Promise<{ readOnly: boolean } | null>;
}

export interface GrantRecord {
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  id: string;
  kind: ArtifactGrantKind;
  status: ArtifactGrantStatus;
  target: string;
  versionId: string;
}

export type PromoteResult =
  | { status: "promoted"; version: number }
  | { pending: GrantRecord[]; requestId: string; status: "waiting" };

const grantRecord = (row: ArtifactGrantRow): GrantRecord => ({
  createdAt: row.createdAt,
  decidedAt: row.decidedAt,
  decidedBy: row.decidedBy,
  id: row.id,
  kind: row.kind,
  status: row.status,
  target: row.target,
  versionId: row.versionId,
});

const policyRecord = (artifact: ArtifactRow): ArtifactPolicyRecord => ({
  agentId: artifact.agentId,
  audience: artifact.audience,
  handedToAgentId: artifact.handedToAgentId,
  ownerUserId: artifact.ownerUserId,
});

const recordFilesSchema = z.array(
  z.object({ path: z.string(), text: z.string().optional() })
);

const isDeny = (answer: string | null): boolean => {
  if (answer === null) {
    return false;
  }
  const parsed: unknown = JSON.parse(answer);
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    "decision" in parsed &&
    parsed.decision === "deny"
  );
};

const sameGrant = (
  left: { kind: string; target: string },
  right: { kind: string; target: string }
) => left.kind === right.kind && left.target === right.target;

export const createArtifactGrantsService = ({
  atomic,
  clock,
  db,
  events,
  requests,
  tools,
}: {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: EventsService;
  requests: Pick<RequestsService, "answer" | "open">;
  tools: ToolCatalog;
}) => {
  const requireArtifact = async (principal: Principal, artifactId: string) => {
    if (principal.kind === "system") {
      throw new ForbiddenError("artifacts.grants");
    }
    authorize(principal, "artifacts.grants", {
      id: artifactId,
      kind: "artifact",
      workspaceId: principal.workspaceId,
    });
    const artifact = await findArtifact(db, {
      id: artifactId,
      workspaceId: principal.workspaceId,
    });
    if (!artifact) {
      throw new ServiceError("not_found", "Artifact not found");
    }
    return artifact;
  };

  /** A person who may manage the artifact, or the agent it was made by or handed to. */
  const requireWriter = (principal: Principal, artifact: ArtifactRow) => {
    const allowed =
      principal.kind === "user"
        ? canManage(policyRecord(artifact), {
            isAdmin: principal.isAdmin === true,
            userId: principal.userId,
          })
        : principal.kind === "run" &&
          agentCanUpdate(policyRecord(artifact), principal.agentId);
    if (!allowed) {
      // Not found, so a private artifact stays hidden from a caller who cannot open it.
      throw new ServiceError("not_found", "Artifact not found");
    }
  };

  const requireVersion = async (artifact: ArtifactRow, versionId: string) => {
    const version = await findVersion(db, {
      artifactId: artifact.id,
      id: versionId,
      workspaceId: artifact.workspaceId,
    });
    if (!version) {
      throw new ServiceError("not_found", "Version not found");
    }
    return version;
  };

  const actorOf = async (principal: Principal) => {
    if (principal.kind === "user") {
      return { actor: { id: principal.userId, kind: "user" as const } };
    }
    if (principal.kind === "run") {
      const run = await loadRun(db, principal.runId, principal.workspaceId);
      return {
        actor: { id: principal.agentId, kind: "agent" as const },
        agentId: principal.agentId,
        runId: principal.runId,
        sessionId: run?.sessionId,
      };
    }
    return { actor: { id: "system", kind: "system" as const } };
  };

  const checkTools = async (workspaceId: string, declared: DeclaredGrant[]) => {
    for (const grant of declared) {
      if (grant.kind !== "tool" || grant.target.includes(LIMITS_SEPARATOR)) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: at most 50 tools, and the first refusal ends it
      const found = await tools.lookup(workspaceId, grant.target);
      if (!found) {
        throw new ServiceError("invalid", `Unknown tool ${grant.target}`);
      }
      if (!found.readOnly) {
        throw new ServiceError(
          "invalid",
          `Tool ${grant.target} is not read-only, so it cannot be granted`
        );
      }
    }
  };

  /**
   * Writes the grant rows of a new version from its `harbourmaster.json`. Call it
   * once the version row exists. Calling it again for the same version returns
   * the rows already there. A person's own version is approved as written. An
   * agent's version is approved only where the current version already holds
   * the same approved grant, and waits pending for the rest.
   */
  const recordVersionGrants = async (
    principal: Principal,
    raw: {
      artifactId: string;
      files: { path: string; text?: string }[];
      versionId: string;
    }
  ): Promise<GrantRecord[]> => {
    const files = recordFilesSchema.parse(raw.files);
    const artifact = await requireArtifact(principal, raw.artifactId);
    requireWriter(principal, artifact);
    const version = await requireVersion(artifact, raw.versionId);
    const existing = await listGrants(db, {
      versionId: version.id,
      workspaceId: artifact.workspaceId,
    });
    if (existing.length > 0) {
      return existing.map(grantRecord);
    }
    const declared = declaredGrants(parseManifest(files));
    await checkTools(artifact.workspaceId, declared);
    const carried =
      artifact.currentVersionId && artifact.currentVersionId !== version.id
        ? await approvedGrants(db, {
            versionId: artifact.currentVersionId,
            workspaceId: artifact.workspaceId,
          })
        : [];
    const now = clock.now().toISOString();
    // Approved as written only when the author is the person calling: an agent
    // that names a person's version does not get that person's approval.
    const byPerson =
      principal.kind === "user" &&
      version.authorKind === "user" &&
      version.authorId === principal.userId;
    const rows = declared.map((grant) => {
      const approved =
        byPerson || carried.some((held) => sameGrant(held, grant));
      return {
        createdAt: now,
        decidedAt: approved ? now : null,
        decidedBy: byPerson ? version.authorId : null,
        id: ulid(),
        kind: grant.kind,
        status: approved ? ("approved" as const) : ("pending" as const),
        target: grant.target,
        versionId: version.id,
        workspaceId: artifact.workspaceId,
      };
    });
    if (rows.length > 0) {
      await atomic([insertGrants(db, rows)]);
    }
    return rows.map(grantRecord);
  };

  /** The grants of one version, for a person who may open the artifact. */
  const list = async (
    principal: Principal,
    raw: { artifactId: string; versionId: string }
  ): Promise<GrantRecord[]> => {
    const artifact = await requireArtifact(principal, raw.artifactId);
    if (
      principal.kind !== "user" ||
      !canOpen(policyRecord(artifact), {
        isAdmin: principal.isAdmin === true,
        userId: principal.userId,
      })
    ) {
      throw new ServiceError("not_found", "Artifact not found");
    }
    const version = await requireVersion(artifact, raw.versionId);
    const rows = await listGrants(db, {
      versionId: version.id,
      workspaceId: artifact.workspaceId,
    });
    return rows.map(grantRecord);
  };

  /** Settles the Needs you card of a version once its grants are all decided. Best effort. */
  const settleRequest = async (
    principal: Extract<Principal, { kind: "user" }>,
    artifact: ArtifactRow,
    versionId: string
  ) => {
    const [latest] = await promoteRequests(db, {
      versionId,
      workspaceId: artifact.workspaceId,
    });
    if (latest?.status !== "pending") {
      return;
    }
    const rows = await listGrants(db, {
      versionId,
      workspaceId: artifact.workspaceId,
    });
    const rejected = rows.some((row) => row.status === "rejected");
    if (!(rejected || rows.every((row) => row.status === "approved"))) {
      return;
    }
    try {
      await requests.answer(principal, {
        answer: { decision: rejected ? "deny" : "allow_once" },
        requestId: latest.id,
        via: "web",
      });
    } catch (error) {
      // The decider may not see the agent's session, or someone answered the
      // card first. The grants are decided either way, and the card is a notice.
      if (!(error instanceof ForbiddenError || error instanceof ServiceError)) {
        throw error;
      }
    }
  };

  /** A person approves or rejects one grant. The owner or an admin decides. */
  const decideGrant = async (principal: Principal, raw: unknown) => {
    const input = artifactsDecideGrantInputSchema.parse(raw);
    if (principal.kind !== "user") {
      throw new ForbiddenError("artifacts.decide_grant");
    }
    authorize(principal, "artifacts.decide_grant", {
      id: input.grantId,
      kind: "artifact_grant",
      workspaceId: principal.workspaceId,
    });
    const grant = await findGrant(db, {
      id: input.grantId,
      workspaceId: principal.workspaceId,
    });
    const version = grant
      ? await findVersionById(db, {
          id: grant.versionId,
          workspaceId: principal.workspaceId,
        })
      : null;
    if (!(grant && version)) {
      throw new ServiceError("not_found", "Grant not found");
    }
    const artifact = await requireArtifact(principal, version.artifactId);
    if (
      !canManage(policyRecord(artifact), {
        isAdmin: principal.isAdmin === true,
        userId: principal.userId,
      })
    ) {
      throw new ServiceError("not_found", "Grant not found");
    }
    if (grant.status !== "pending") {
      throw new ServiceError("conflict", "Grant already decided");
    }
    const now = clock.now().toISOString();
    await atomic([
      decideGrantStatement(db, {
        decidedAt: now,
        decidedBy: principal.userId,
        id: grant.id,
        status: input.decision,
      }),
      ...(input.decision === "rejected"
        ? [rejectVersionStatement(db, grant.versionId)]
        : []),
    ]);
    await events.append({
      actor: { id: principal.userId, kind: "user" },
      payload: {
        artifactId: artifact.id,
        decision: input.decision,
        grantId: grant.id,
        kind: grant.kind,
        target: grant.target,
        versionId: grant.versionId,
      },
      type: "artifact.grant_decided",
      workspaceId: artifact.workspaceId,
    });
    await settleRequest(principal, artifact, grant.versionId);
  };

  const openPromoteRequest = async (
    principal: Extract<Principal, { kind: "run" }>,
    artifact: ArtifactRow,
    version: { id: string; number: number },
    pending: ArtifactGrantRow[]
  ) => {
    const prior = await promoteRequests(db, {
      versionId: version.id,
      workspaceId: artifact.workspaceId,
    });
    const [latest] = prior;
    if (latest?.status === "pending") {
      return latest.id;
    }
    if (latest?.status === "answered" && isDeny(latest.answer)) {
      throw new ServiceError(
        "conflict",
        "A person declined this version in Needs you"
      );
    }
    const asks = pending.map((row) => row.target);
    const opened = await requests.open(SYSTEM_PRINCIPAL, {
      input: {
        artifactId: artifact.id,
        grants: pending.map((row) => ({
          id: row.id,
          kind: row.kind,
          target: row.target,
        })),
        query: `${artifact.title} v${version.number} asks for ${asks.join(", ")}`,
        title: artifact.title,
        version: version.number,
        versionId: version.id,
      },
      kind: "approval",
      runId: principal.runId,
      toolKey: PROMOTE_TOOL_KEY,
      toolName: PROMOTE_TOOL_NAME,
      toolUseId: `${PROMOTE_TOOL_USE_PREFIX}${version.id}:${prior.length + 1}`,
    });
    return opened.id;
  };

  /**
   * Makes a proposed app version current. With every grant approved it goes
   * live. With some pending, a run gets a Needs you request and `waiting`; a
   * person gets a conflict naming what is open. A rejected grant ends it.
   */
  const promote = async (
    principal: Principal,
    raw: unknown
  ): Promise<PromoteResult> => {
    const input = artifactsPromoteInputSchema.parse(raw);
    const artifact = await requireArtifact(principal, input.artifactId);
    requireWriter(principal, artifact);
    if (artifact.kind !== "app") {
      throw new ServiceError(
        "invalid",
        "Only app versions are promoted; other kinds publish at once"
      );
    }
    const version = await requireVersion(artifact, input.versionId);
    if (
      version.status === "published" &&
      artifact.currentVersionId === version.id
    ) {
      return { status: "promoted", version: version.number };
    }
    if (version.status !== "proposed") {
      throw new ServiceError(
        "conflict",
        `Version ${version.number} is ${version.status}, not proposed`
      );
    }
    const rows = await listGrants(db, {
      versionId: version.id,
      workspaceId: artifact.workspaceId,
    });
    if (rows.some((row) => row.status === "rejected")) {
      throw new ServiceError(
        "conflict",
        "A grant of this version was rejected"
      );
    }
    const pending = rows.filter((row) => row.status === "pending");
    if (pending.length > 0) {
      if (principal.kind !== "run") {
        throw new ServiceError(
          "conflict",
          `${pending.length} grant(s) of this version need a decision first`
        );
      }
      return {
        pending: pending.map(grantRecord),
        requestId: await openPromoteRequest(
          principal,
          artifact,
          version,
          pending
        ),
        status: "waiting",
      };
    }
    const now = clock.now().toISOString();
    await atomic(
      promoteStatements(db, {
        artifactId: artifact.id,
        now,
        versionId: version.id,
      })
    );
    await events.append({
      ...(await actorOf(principal)),
      payload: {
        artifactId: artifact.id,
        title: artifact.title,
        version: version.number,
        versionId: version.id,
      },
      type: "artifact.promoted",
      workspaceId: artifact.workspaceId,
    });
    return { status: "promoted", version: version.number };
  };

  /** The owner or an admin lets one other agent update the artifact, or takes it back with null. */
  const handTo = async (principal: Principal, raw: unknown) => {
    const input = artifactsHandToInputSchema.parse(raw);
    const artifact = await requireArtifact(principal, input.artifactId);
    if (principal.kind !== "user") {
      throw new ForbiddenError("artifacts.hand_to");
    }
    requireWriter(principal, artifact);
    if (input.agentId !== null) {
      const agent = await findAgent(db, {
        id: input.agentId,
        workspaceId: artifact.workspaceId,
      });
      if (!agent) {
        throw new ServiceError("not_found", "Agent not found");
      }
    }
    if (artifact.handedToAgentId === input.agentId) {
      return;
    }
    await atomic([
      setHandedToStatement(db, {
        agentId: input.agentId,
        artifactId: artifact.id,
        now: clock.now().toISOString(),
      }),
    ]);
    await events.append({
      actor: { id: principal.userId, kind: "user" },
      agentId: input.agentId,
      payload: {
        agentId: input.agentId,
        artifactId: artifact.id,
        previousAgentId: artifact.handedToAgentId,
      },
      type: "artifact.handed_to",
      workspaceId: artifact.workspaceId,
    });
  };

  return { decideGrant, handTo, list, promote, recordVersionGrants };
};

export type ArtifactGrantsService = ReturnType<
  typeof createArtifactGrantsService
>;
