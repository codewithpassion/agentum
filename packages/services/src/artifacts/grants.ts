/**
 * Grants, promote and hand-to for app artifacts (PRD R2.4, R2.9, phase 2).
 *
 * A version that asks for tools, secrets, hosts, endpoints or agents gets one `artifact_grants`
 * row per ask. A row its author approved on a browser session, or that the
 * current version already holds approved, is `approved`; the rest wait `pending`.
 * `promote` makes a proposed version current once none of its rows is pending.
 * When some are, an agent's promote opens an approval in Needs you and
 * returns `waiting`, and the person's `decideGrant` answers that approval.
 */

import type { Database } from "@repo/db";
import { ensureEndpointStatement } from "@repo/db/artifact-endpoints";
import {
  type ArtifactGrantRow,
  type ArtifactRow,
  approvedGrants,
  claimProposedVersion,
  findArtifact,
  findGrant,
  findVersion,
  findVersionById,
  insertGrants,
  listGrants,
  PROMOTE_TOOL_NAME,
  PROMOTE_TOOL_USE_PREFIX,
  promoteRequests,
  rejectVersionStatement,
  setCurrentVersionStatement,
  setHandedToStatement,
} from "@repo/db/artifact-grants";
import type { Atomic, Statement } from "@repo/db/atomic";
import { artifactGrants } from "@repo/db/schema/artifacts";
import { runRequests } from "@repo/db/schema/requests";
import { triggers } from "@repo/db/schema/triggers";
import type { ArtifactGrantKind, ArtifactGrantStatus } from "@repo/db/shared";
import {
  artifactsDecideGrantInputSchema,
  artifactsHandToInputSchema,
  artifactsPromoteInputSchema,
} from "@repo/protocol/artifacts";
import { and, eq, getTableColumns, inArray, type SQL, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { findAgent } from "../agents.ts";
import { authorize, ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import { isPromoteApproval } from "../mail/approval.ts";
import type { RequestsService } from "../requests.ts";
import { loadRun } from "../runs/queries.ts";
import type { Clock } from "../runs/types.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { endpointId } from "./endpoints.ts";
import {
  type DeclaredGrant,
  declaredGrants,
  parseManifest,
} from "./manifest.ts";
import {
  type ArtifactPolicyRecord,
  agentCanSee,
  agentCanUpdate,
  canManage,
  canOpen,
} from "./policy.ts";
import { replacementVersions } from "./replacements.ts";

/** The `toolKey` the Needs you card shows for a promote request. */
const PROMOTE_TOOL_KEY = "harbourmaster/artifact_promote";
/** Marks a limits row (`<tool>#<json>`) among the tool grants. */
const LIMITS_SEPARATOR = "#";

/** What the grant checks need to know about a tool a version asks for. */
export interface ToolCatalog {
  /**
   * The tool by `<serverKey>/<tool>`, or null when the workspace has no such
   * tool. `agentId` is the agent whose connector list gives the server keys
   * (the artifact's maker), or null for an artifact a person made.
   */
  lookup: (
    workspaceId: string,
    toolKey: string,
    agentId: string | null
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
  | { pending: GrantRecord[]; requestId?: string; status: "waiting" };

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

/** The limits rows (`<tool>#<json>`) a set holds for one tool, sorted. */
const limitRows = (set: readonly { target: string }[], tool: string) =>
  set
    .map((held) => held.target)
    .filter((target) => target.startsWith(`${tool}${LIMITS_SEPARATOR}`))
    .sort();

/**
 * Whether the approved set already covers `grant`. A tool without limits is
 * covered only when every limit the set holds for it is still declared:
 * dropping an approved limit widens the grant, so it needs a person again.
 */
const covered = (
  carried: readonly { kind: string; target: string }[],
  declared: readonly { kind: string; target: string }[],
  grant: { kind: string; target: string }
): boolean => {
  if (!carried.some((held) => sameGrant(held, grant))) {
    return false;
  }
  if (grant.kind !== "tool" || grant.target.includes(LIMITS_SEPARATOR)) {
    return true;
  }
  const declaredLimits = limitRows(declared, grant.target);
  return limitRows(carried, grant.target).every((row) =>
    declaredLimits.includes(row)
  );
};

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

  const checkTools = async (
    workspaceId: string,
    agentId: string | null,
    declared: DeclaredGrant[]
  ) => {
    for (const grant of declared) {
      if (
        grant.kind === "agent" &&
        // biome-ignore lint/performance/noAwaitInLoops: validate each declared agent in its workspace
        !(await findAgent(db, { id: grant.target, workspaceId }))
      ) {
        throw new ServiceError(
          "invalid",
          "Agent is not in the artifact workspace"
        );
      }
      if (grant.kind !== "tool" || grant.target.includes(LIMITS_SEPARATOR)) {
        continue;
      }
      const found = await tools.lookup(workspaceId, grant.target, agentId);
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

  /** Grant approval is consent to clear a revoke; it never resumes a paused trigger. */
  const approveAppAgentStatement = async (
    artifact: ArtifactRow,
    agentId: string,
    userId: string,
    consent: boolean,
    guard: SQL = sql`true`
  ) => {
    const agent = await findAgent(db, {
      id: agentId,
      workspaceId: artifact.workspaceId,
    });
    if (!agent) {
      throw new ServiceError(
        "invalid",
        "Agent is not in the artifact workspace"
      );
    }
    const now = clock.now().toISOString();
    const values: Record<string, string | number | null> = {
      agentId,
      approvedAt: now,
      artifactId: artifact.id,
      consecutiveErrors: 0,
      createdAt: now,
      createdBy: userId,
      id: ulid(),
      kind: "app",
      name: artifact.title,
      workspaceId: artifact.workspaceId,
    };
    // INSERT SELECT lets a racing decision upsert only while its grant is pending.
    const fields = Object.keys(getTableColumns(triggers)).map(
      (key) => sql`${values[key] ?? null}`
    );
    // Wrap the thenable so this async helper leaves execution to atomic.
    return {
      statement: db
        .insert(triggers)
        .select(sql`select ${sql.join(fields, sql`, `)} where ${guard}`)
        .onConflictDoUpdate({
          set: consent
            ? { approvedAt: now, proposedByAgentId: null, revokedAt: null }
            : { proposedByAgentId: null },
          target: [triggers.artifactId, triggers.agentId],
          targetWhere: sql`${triggers.artifactId} is not null`,
        }),
    };
  };

  // Version changes never pause app triggers. startRun checks the live grant;
  // disabledAt belongs to explicit pauses and grant revocations.
  const liveVersionStatements = (
    artifact: ArtifactRow,
    version: { id: string; number: number }
  ) => [
    setCurrentVersionStatement(db, {
      artifactId: artifact.id,
      now: clock.now().toISOString(),
      versionId: version.id,
      versionNumber: version.number,
    }),
  ];

  /**
   * Refuses a manifest before a version is written: it must parse and ask only
   * for tools that exist and are read-only. Create and update call it first, so
   * a bad app never becomes a version.
   */
  const checkManifest = async (
    principal: Principal,
    files: { path: string; text?: string }[],
    /** The artifact's maker, whose connectors name the tools. Defaults to the caller's agent. */
    makerAgentId?: string | null
  ) => {
    if (principal.kind === "system") {
      throw new ForbiddenError("artifacts.grants");
    }
    authorize(principal, "artifacts.grants", {
      kind: "artifact",
      workspaceId: principal.workspaceId,
    });
    const callerAgentId = principal.kind === "run" ? principal.agentId : null;
    await checkTools(
      principal.workspaceId,
      makerAgentId === undefined ? callerAgentId : makerAgentId,
      declaredGrants(parseManifest(recordFilesSchema.parse(files)))
    );
  };

  const endpointStatements = (
    artifact: ArtifactRow,
    grants: { id: string; kind: ArtifactGrantKind; target: string }[]
  ) =>
    grants
      .filter((grant) => grant.kind === "endpoint")
      .map((grant) =>
        ensureEndpointStatement(
          db,
          {
            artifactId: artifact.id,
            createdAt: clock.now().toISOString(),
            id: endpointId(),
            name: grant.target,
            workspaceId: artifact.workspaceId,
          },
          grant.id
        )
      );

  /**
   * Writes the grant rows of a new version from its `agentum.json`. Call it
   * once the version row exists. Calling it again for the same version returns
   * the rows already there. A person’s browser-session version is approved as
   * written. Other versions carry the current version’s approved grants and
   * wait pending for the rest.
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
    await checkTools(artifact.workspaceId, artifact.agentId, declared);
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
      principal.via === "session" &&
      version.authorKind === "user" &&
      version.authorId === principal.userId;
    const rows = declared.map((grant) => {
      const approved = byPerson || covered(carried, declared, grant);
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
    const statements: Statement[] = rows.length ? [insertGrants(db, rows)] : [];
    const triggerWrites = await Promise.all(
      rows
        .filter((row) => row.kind === "agent" && row.status === "approved")
        .map((row) =>
          approveAppAgentStatement(
            artifact,
            row.target,
            row.decidedBy ?? "system",
            byPerson
          )
        )
    );
    statements.push(...triggerWrites.map((write) => write.statement));
    statements.push(
      ...endpointStatements(
        artifact,
        rows.filter((row) => row.status === "approved")
      )
    );
    await atomic(statements);
    // A person's update is a proposal only while it needs new consent. Run
    // proposals still require promote even when every grant is carried.
    if (
      version.authorKind === "user" &&
      version.status === "proposed" &&
      rows.every((row) => row.status === "approved") &&
      (await newerThanCurrent(artifact, version))
    ) {
      await goLiveVersion(artifact, version, await actorOf(principal));
    }
    return rows.map(grantRecord);
  };

  /** The grants of one version, for a person who may open the artifact. */
  const list = async (
    principal: Principal,
    raw: { artifactId: string; versionId: string }
  ): Promise<GrantRecord[]> => {
    const artifact = await requireArtifact(principal, raw.artifactId);
    if (principal.kind === "run") {
      if (!agentCanSee(policyRecord(artifact), principal.agentId)) {
        throw new ServiceError("not_found", "Artifact not found");
      }
    } else if (
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

  /** Whether the version is newer than the live one, so taking it live never rolls the app back. */
  const newerThanCurrent = async (
    artifact: ArtifactRow,
    version: { number: number }
  ) => {
    const current = artifact.currentVersionId
      ? await findVersionById(db, {
          id: artifact.currentVersionId,
          workspaceId: artifact.workspaceId,
        })
      : null;
    return !current || version.number > current.number;
  };

  const decidedAgentStatements = async (
    artifact: ArtifactRow,
    grants: ArtifactGrantRow[],
    decision: "approved" | "rejected",
    userId: string
  ) => {
    const writes = await Promise.all(
      grants
        .filter((grant) => grant.kind === "agent")
        .map(async (grant) => {
          const guard = sql`exists (select 1 from ${artifactGrants} where ${artifactGrants.id} = ${grant.id} and ${artifactGrants.status} = 'pending')`;
          if (decision === "approved") {
            return await approveAppAgentStatement(
              artifact,
              grant.target,
              userId,
              true,
              guard
            );
          }
          if (grant.versionId !== artifact.currentVersionId) {
            return null;
          }
          return {
            statement: db
              .update(triggers)
              .set({
                disabledAt: sql`coalesce(${triggers.disabledAt}, ${clock.now().toISOString()})`,
              })
              .where(
                and(
                  eq(triggers.artifactId, artifact.id),
                  eq(triggers.agentId, grant.target),
                  guard
                )
              ),
          };
        })
    );
    return writes
      .filter((write) => write !== null)
      .map((write) => write.statement);
  };

  /**
   * Writes one decision over some grants of a version, with an event each. A
   * rejection rejects the version. When `goLive` is set (a promote was asked
   * for), an approval that leaves nothing pending takes the version live. Only
   * the call whose update changed a grant writes its event and goes live, so a
   * repeat or a racing call finds nothing to do and the result is `stale`.
   */
  const applyDecisions = async (
    artifact: ArtifactRow,
    grants: ArtifactGrantRow[],
    decision: "approved" | "rejected",
    userId: string,
    goLive: boolean
  ): Promise<"decided" | "live" | "stale"> => {
    const [first] = grants;
    if (!first) {
      return "stale";
    }
    let claimed = new Set<string>();
    const statements: Statement[] = await decidedAgentStatements(
      artifact,
      grants,
      decision,
      userId
    );
    const claimIndex = statements.length;
    statements.push(
      db
        .update(artifactGrants)
        .set({
          decidedAt: clock.now().toISOString(),
          decidedBy: userId,
          status: decision,
        })
        .where(
          and(
            inArray(
              artifactGrants.id,
              grants.map((grant) => grant.id)
            ),
            eq(artifactGrants.status, "pending")
          )
        )
        .returning({ id: artifactGrants.id })
    );
    if (decision === "approved") {
      statements.push(...endpointStatements(artifact, grants));
    }
    await atomic(statements, (results) => {
      const rows = z
        .array(z.object({ id: z.string() }))
        .parse(results[claimIndex]);
      claimed = new Set(rows.map((row) => row.id));
    });
    const won = grants.filter((grant) => claimed.has(grant.id));
    if (won.length === 0) {
      return "stale";
    }
    if (decision === "rejected") {
      await atomic([rejectVersionStatement(db, first.versionId)]);
    }
    for (const grant of won) {
      // biome-ignore lint/performance/noAwaitInLoops: preserve grant event order
      await events.append({
        actor: { id: userId, kind: "user" },
        payload: {
          artifactId: artifact.id,
          decision,
          grantId: grant.id,
          kind: grant.kind,
          target: grant.target,
          versionId: grant.versionId,
        },
        type: "artifact.grant_decided",
        workspaceId: artifact.workspaceId,
      });
    }
    if (!(goLive && decision === "approved" && artifact.kind === "app")) {
      return "decided";
    }
    const [version, rows] = await Promise.all([
      findVersionById(db, {
        id: first.versionId,
        workspaceId: artifact.workspaceId,
      }),
      listGrants(db, {
        versionId: first.versionId,
        workspaceId: artifact.workspaceId,
      }),
    ]);
    if (
      version &&
      rows.every((row) => row.status === "approved") &&
      (await newerThanCurrent(artifact, version)) &&
      (await goLiveVersion(artifact, version, {
        actor: { id: userId, kind: "user" },
      }))
    ) {
      return "live";
    }
    return "decided";
  };

  /**
   * Applies a person's answer on the Needs you card to the grants it listed, so
   * answering the card decides them as `decideGrant` would. Only the owner's
   * answer counts: the card's visibility follows the agent's session, not the
   * artifact, and an admin decides on the artifact page. Anything else is a
   * conflict, so the agent never loops on a card nobody can act on.
   */
  const applyCardAnswer = async (
    artifact: ArtifactRow,
    card: { answer: string | null; answeredBy: string | null },
    pending: ArtifactGrantRow[]
  ) => {
    if (card.answeredBy === null || card.answeredBy !== artifact.ownerUserId) {
      throw new ServiceError(
        "conflict",
        "The card was answered by someone who cannot decide these grants; decide them on the artifact page"
      );
    }
    const denied = isDeny(card.answer);
    await applyDecisions(
      artifact,
      pending,
      denied ? "rejected" : "approved",
      card.answeredBy,
      true
    );
    if (denied) {
      throw new ServiceError(
        "conflict",
        "A person declined this version in Needs you"
      );
    }
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
    if (principal.kind !== "user" || principal.via !== "session") {
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
    // Agent grants use a rejection of an approved row as revocation. Unlike a
    // declined proposal, revoking a live grant leaves the published version live.
    if (
      grant.kind === "agent" &&
      grant.status === "approved" &&
      grant.versionId === artifact.currentVersionId &&
      input.decision === "rejected"
    ) {
      const now = clock.now().toISOString();
      await atomic([
        db
          .update(artifactGrants)
          .set({
            decidedAt: now,
            decidedBy: principal.userId,
            status: "rejected",
          })
          .where(
            and(
              eq(artifactGrants.id, grant.id),
              eq(artifactGrants.status, "approved")
            )
          ),
        db
          .update(triggers)
          .set({ disabledAt: sql`coalesce(${triggers.disabledAt}, ${now})` })
          .where(
            and(
              eq(triggers.artifactId, artifact.id),
              eq(triggers.agentId, grant.target)
            )
          ),
      ]);
      await events.append({
        actor: { id: principal.userId, kind: "user" },
        payload: {
          artifactId: artifact.id,
          decision: "rejected",
          grantId: grant.id,
          kind: grant.kind,
          target: grant.target,
          versionId: grant.versionId,
        },
        type: "artifact.grant_decided",
        workspaceId: artifact.workspaceId,
      });
      return;
    }
    if (grant.status !== "pending") {
      throw new ServiceError("conflict", "Grant already decided");
    }
    const asked = (
      await promoteRequests(db, {
        versionId: grant.versionId,
        workspaceId: artifact.workspaceId,
      })
    ).length;
    const outcome = await applyDecisions(
      artifact,
      [grant],
      input.decision,
      principal.userId,
      asked > 0 || version.authorKind === "user"
    );
    if (outcome === "stale") {
      throw new ServiceError("conflict", "Grant already decided");
    }
    await settleRequest(principal, artifact, grant.versionId);
  };

  const openPromoteRequest = async (
    principal: { runId: string },
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
    const agentNames = new Map(
      await Promise.all(
        pending
          .filter((row) => row.kind === "agent")
          .map(
            async (row) =>
              [
                row.target,
                await findAgent(db, {
                  id: row.target,
                  workspaceId: artifact.workspaceId,
                }).then((agent) => (agent ? agent.name : "Unavailable agent")),
              ] as const
          )
      )
    );
    const asks = pending.map((row) => row.target);
    const opened = await requests.open(SYSTEM_PRINCIPAL, {
      input: {
        artifactId: artifact.id,
        grants: pending.map((row) => ({
          id: row.id,
          kind: row.kind,
          ...(row.kind === "agent"
            ? { name: agentNames.get(row.target) ?? "Unavailable agent" }
            : {}),
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

  const announcePromoted = (
    artifact: ArtifactRow,
    version: { id: string; number: number },
    actor: Awaited<ReturnType<typeof actorOf>>
  ) =>
    events.append({
      ...actor,
      payload: {
        artifactId: artifact.id,
        title: artifact.title,
        version: version.number,
        versionId: version.id,
      },
      type: "artifact.promoted",
      workspaceId: artifact.workspaceId,
    });

  /**
   * Takes a proposed version live and says whether this call did it. The claim
   * on the version is the arbiter: of two callers that race, one writes the
   * event. A crash between the claim and the current pointer is finished by the
   * next `promote` of the version.
   */
  const goLiveVersion = async (
    artifact: ArtifactRow,
    version: { id: string; number: number },
    actor: Awaited<ReturnType<typeof actorOf>>
  ): Promise<boolean> => {
    if (!(await claimProposedVersion(db, version.id))) {
      return false;
    }
    await atomic(liveVersionStatements(artifact, version));
    await announcePromoted(artifact, version, actor);
    return true;
  };

  const pendingGrantsMessage = (principal: Principal, count: number): string =>
    principal.kind === "user" && principal.via === "session"
      ? `${count} ${count === 1 ? "grant waits" : "grants wait"} for approval in Needs you. Approve them there, then promote this version.`
      : `Open the artifact in the browser and approve its ${count} pending ${count === 1 ? "grant" : "grants"} in Needs you before promoting.`;

  /**
   * What a promote does about grants still pending: apply an answered card,
   * then open or reuse the authoring run’s card and answer `waiting`.
   * Without an active authoring run, explain the browser approval step. Null when nothing is left to wait for.
   */
  const holdForGrants = async (
    principal: Principal,
    artifact: ArtifactRow,
    version: { id: string; number: number; authorRunId: string | null },
    pending: ArtifactGrantRow[]
  ): Promise<PromoteResult | null> => {
    if (pending.length === 0) {
      return null;
    }
    const [card] = await promoteRequests(db, {
      versionId: version.id,
      workspaceId: artifact.workspaceId,
    });
    if (card?.status === "answered") {
      await applyCardAnswer(artifact, card, pending);
      return null;
    }
    const mcpUser = principal.kind === "user" && principal.via !== "session";
    const authorRunId = mcpUser ? version.authorRunId : null;
    const runId = principal.kind === "run" ? principal.runId : authorRunId;
    const run = runId ? await loadRun(db, runId, artifact.workspaceId) : null;
    if (
      !runId ||
      (principal.kind !== "run" &&
        card?.status !== "pending" &&
        !(run && ["running", "waiting"].includes(run.status)))
    ) {
      throw new ServiceError(
        "conflict",
        pendingGrantsMessage(principal, pending.length)
      );
    }
    return {
      pending: pending.map(grantRecord),
      requestId: await openPromoteRequest(
        { runId },
        artifact,
        version,
        pending
      ),
      status: "waiting",
    };
  };

  /** MCP user apps have grant cards rather than run requests in Needs you. */
  const pendingForMcpUser = async (
    principal: Principal,
    artifact: ArtifactRow,
    version: { id: string; authorKind: string; number: number }
  ): Promise<PromoteResult | null> => {
    if (
      principal.kind !== "user" ||
      principal.via === "session" ||
      version.authorKind !== "user"
    ) {
      return null;
    }
    const rows = await listGrants(db, {
      versionId: version.id,
      workspaceId: artifact.workspaceId,
    });
    const rejected = rows.filter((row) => row.status === "rejected");
    if (rejected.length) {
      throw new ServiceError(
        "conflict",
        `This version was rejected: ${rejected.map((row) => `${row.kind} ${row.target}`).join(", ")}. Create a new version.`
      );
    }
    const [replacement] = await replacementVersions(db, {
      artifactId: sql`${artifact.id}`,
      currentVersionId: sql`${artifact.currentVersionId}`,
      number: sql`${version.number}`,
    });
    if (replacement && version.id !== artifact.currentVersionId) {
      throw new ServiceError(
        "conflict",
        `This version was replaced by version ${replacement.number}. Create a new version.`
      );
    }
    const pending = rows.filter((row) => row.status === "pending");
    return pending.length
      ? { pending: pending.map(grantRecord), status: "waiting" }
      : null;
  };

  /**
   * Promotes a run-authored app once its grants are approved. A person’s
   * pending version waits on its grouped grant card in Needs you.
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
    // MCP is not consent. Needs you lists user-authored pending grants
    // directly because these versions have no authoring run card.
    const waitingForPerson = await pendingForMcpUser(
      principal,
      artifact,
      version
    );
    if (waitingForPerson) {
      return waitingForPerson;
    }
    if (
      version.status === "published" &&
      artifact.currentVersionId === version.id
    ) {
      return { status: "promoted", version: version.number };
    }
    if (
      version.status === "published" &&
      (await newerThanCurrent(artifact, version))
    ) {
      // A go-live that stopped after publishing the version: finish it.
      await atomic(liveVersionStatements(artifact, version));
      await announcePromoted(artifact, version, await actorOf(principal));
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
    const waiting = await holdForGrants(
      principal,
      artifact,
      version,
      rows.filter((row) => row.status === "pending")
    );
    if (waiting) {
      return waiting;
    }
    if (!(await newerThanCurrent(artifact, version))) {
      throw new ServiceError(
        "conflict",
        `Version ${version.number} is older than the live version`
      );
    }
    await goLiveVersion(artifact, version, await actorOf(principal));
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

  /** The answered promote card an event is about, with its proposed version and artifact. */
  const answeredCard = async (event: {
    payload: Record<string, unknown>;
    workspaceId: string;
  }) => {
    const { requestId } = event.payload;
    if (typeof requestId !== "string") {
      return null;
    }
    const [card] = await db
      .select()
      .from(runRequests)
      .where(
        and(
          eq(runRequests.id, requestId),
          eq(runRequests.workspaceId, event.workspaceId)
        )
      );
    if (!(card && isPromoteApproval(card))) {
      return null;
    }
    const [, versionId] = card.toolUseId.split(":");
    const version = versionId
      ? await findVersionById(db, {
          id: versionId,
          workspaceId: card.workspaceId,
        })
      : null;
    const artifact = version
      ? await findArtifact(db, {
          id: version.artifactId,
          workspaceId: card.workspaceId,
        })
      : null;
    return artifact && version?.status === "proposed"
      ? { artifact, card, version }
      : null;
  };

  // A person's answer on the card decides the grants it listed, and an allow
  // takes the version live, so the answer carries the version forward even when
  // the run that asked has ended. The listener never fails the answer.
  events.onAppend(async (event) => {
    if (event.type !== "request.answered") {
      return;
    }
    const target = await answeredCard(event);
    if (!target) {
      return;
    }
    const { artifact, card, version } = target;
    const rows = await listGrants(db, {
      versionId: version.id,
      workspaceId: artifact.workspaceId,
    });
    const pending = rows.filter((row) => row.status === "pending");
    if (pending.length === 0 || rows.some((row) => row.status === "rejected")) {
      return;
    }
    try {
      await applyCardAnswer(artifact, card, pending);
    } catch (error) {
      // A denial or a non-owner's answer is a conflict the next promote reports.
      if (error instanceof ServiceError) {
        return;
      }
      throw error;
    }
  });

  return {
    checkManifest,
    decideGrant,
    handTo,
    list,
    promote,
    recordVersionGrants,
  };
};

export type ArtifactGrantsService = ReturnType<
  typeof createArtifactGrantsService
>;
