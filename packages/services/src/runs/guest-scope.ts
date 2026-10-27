/** Database predicates shared by scoped lifecycle operations. No Principal is minted. */
import type { Database } from "@repo/db";
import { findGuestSessionGrant } from "@repo/db/live-guests";
import { guestIdentities } from "@repo/db/schema/live-artifacts";
import { runs } from "@repo/db/schema/runs";
import type { GuestGrant } from "@repo/protocol/live";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { hashToken } from "../crypto.ts";

const SESSION_TOKEN = /^hm_guest_[A-Za-z0-9_-]{43}$/;

export const guestUnavailable = () => new ForbiddenError("runs.guest_access");

export const authenticateGuestRun = async (
  db: Database,
  grant: GuestGrant,
  token: string | undefined,
  at: string
) => {
  if (!(token && SESSION_TOKEN.test(token))) {
    throw guestUnavailable();
  }
  const row = await findGuestSessionGrant(db, {
    artifactId: grant.artifactId,
    at,
    tokenHash: await hashToken(token),
    workspaceId: grant.workspaceId,
  });
  if (
    !row ||
    row.guestId !== grant.guestId ||
    row.role !== grant.role ||
    row.expiresAt !== grant.expiresAt ||
    row.role === "viewer"
  ) {
    throw guestUnavailable();
  }
  return { memberId: row.memberId, sessionId: row.sessionId };
};

const liveGrant = (
  memberId: SQL,
  sessionId: SQL,
  guestId: SQL,
  artifactId: SQL,
  workspaceId: SQL,
  at: string
) => sql`exists (
  select 1 from artifact_members m
  join artifacts a on a.id = m.artifact_id and a.workspace_id = m.workspace_id
  join guest_identities g on g.id = m.guest_id and g.workspace_id = m.workspace_id
  join guest_sessions gs on gs.id = ${sessionId} and gs.guest_id = g.id and gs.workspace_id = m.workspace_id
  join workspaces w on w.id = m.workspace_id
  where m.id = ${memberId} and m.guest_id = ${guestId}
    and m.artifact_id = ${artifactId} and m.workspace_id = ${workspaceId}
    and m.principal_kind = 'guest' and m.user_id is null
    and m.role in ('commenter', 'editor') and m.revoked_at is null
    and m.expires_at > ${at} and gs.expires_at > ${at}
    and a.deleted_at is null and a.kind in ('document', 'deck')
    and w.live_guests_enabled = 1
)`;

/** Unscoped runs retain their existing behavior. Scoped runs require exact provenance
 * and an artifact session in the same workspace, even when the actor claims otherwise. */
export const currentGuestRun = (at: string): SQL => sql`(
  ${runs.scopeArtifactId} is null or (
    ${runs.actorKind} = 'guest'
    and exists (select 1 from agents ag where ag.id = ${runs.agentId}
      and ag.workspace_id = ${runs.workspaceId} and ag.status = 'active')
    and exists (
      select 1 from guest_run_scopes b
      join sessions s on s.id = ${runs.sessionId}
        and s.workspace_id = ${runs.workspaceId}
        and s.origin = 'artifact' and s.private = 0 and s.external_key = ${runs.scopeArtifactId}
      where b.run_id = ${runs.id} and b.workspace_id = ${runs.workspaceId} and ${liveGrant(
        sql`b.member_id`,
        sql`b.session_id`,
        sql`${runs.actorId}`,
        sql`${runs.scopeArtifactId}`,
        sql`${runs.workspaceId}`,
        at
      )}
    )
  )
)`;

/** This assertion executes BEFORE inserting the run in the same Atomic batch.
 * SQLite's write serialization makes the count and insert indivisible across services.
 * A failed assertion rolls back session changes, run, provenance and queued events. */
export const guestStartGuard = (
  db: Database,
  grant: GuestGrant,
  binding: { memberId: string; sessionId: string },
  at: string
) =>
  db
    .update(guestIdentities)
    .set({
      displayName: sql`case when ${liveGrant(
        sql`${binding.memberId}`,
        sql`${binding.sessionId}`,
        sql`${grant.guestId}`,
        sql`${grant.artifactId}`,
        sql`${grant.workspaceId}`,
        at
      )} and (
    select count(*) from runs r where r.workspace_id = ${grant.workspaceId}
      and r.actor_kind = 'guest' and r.actor_id = ${grant.guestId}
      and r.created_at >= ${`${at.slice(0, 10)}T00:00:00.000Z`}
      and r.created_at < ${new Date(Date.parse(at.slice(0, 10)) + 86_400_000).toISOString()}
  ) < (select agent_runs_per_day from artifact_members where id = ${binding.memberId})
  then ${guestIdentities.displayName} else null end`,
    })
    .where(
      and(
        eq(guestIdentities.id, grant.guestId),
        eq(guestIdentities.workspaceId, grant.workspaceId)
      )
    );

/** The existing daemon protocol grants general workspace capabilities. */
export const requireOrdinaryMachineRun = (run: {
  scopeArtifactId: string | null;
}) => {
  if (run.scopeArtifactId) {
    throw guestUnavailable();
  }
};

/** Drizzle/D1 may wrap SQLite's assertion error in several causes. Do not
 * disguise connectivity, missing-table or unrelated constraint errors. */
export const isGuestStartGuardFailure = (error: unknown): boolean => {
  let cause = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!(cause instanceof Error)) {
      return false;
    }
    if (
      cause.message.includes(
        "NOT NULL constraint failed: guest_identities.display_name"
      )
    ) {
      return true;
    }
    const { cause: next } = cause;
    cause = next;
  }
  return false;
};
