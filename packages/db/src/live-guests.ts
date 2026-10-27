/** Read-side guest authentication queries. All references are tenant-joined,
 * including foreign keys: the L.1 foreign keys themselves are not composite.
 * No writes until the durable challenge/rate-limit/outbox schema is available.
 */
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "./database.ts";
import { artifacts } from "./schema/artifacts.ts";
import {
  artifactMembers,
  guestIdentities,
  guestInvites,
  guestSessions,
} from "./schema/live-artifacts.ts";
import { workspaces } from "./schema/workspaces.ts";

const liveMember = (workspaceId: string, at: string) =>
  and(
    eq(artifactMembers.workspaceId, workspaceId),
    eq(artifactMembers.principalKind, "guest"),
    isNull(artifactMembers.userId),
    isNull(artifactMembers.revokedAt),
    gt(artifactMembers.expiresAt, at),
    eq(artifacts.workspaceId, workspaceId),
    isNull(artifacts.deletedAt),
    inArray(artifacts.kind, ["document", "deck"]),
    eq(guestIdentities.workspaceId, workspaceId),
    eq(workspaces.liveGuestsEnabled, true)
  );

/** Read-only scanner-safe landing metadata. No email, ids, code sends or writes. */
export const findGuestInvitation = async (
  db: Database,
  input: {
    tokenHash: string;
    workspaceId: string;
    at: string;
  }
) => {
  const [row] = await db
    .select({
      artifactTitle: artifacts.title,
      createdBy: artifactMembers.createdBy,
      expiresAt: artifactMembers.expiresAt,
      role: artifactMembers.role,
      workspaceName: workspaces.name,
    })
    .from(guestInvites)
    .innerJoin(artifactMembers, eq(artifactMembers.id, guestInvites.memberId))
    .innerJoin(artifacts, eq(artifacts.id, artifactMembers.artifactId))
    .innerJoin(guestIdentities, eq(guestIdentities.id, artifactMembers.guestId))
    .innerJoin(workspaces, eq(workspaces.id, guestInvites.workspaceId))
    .where(
      and(
        eq(guestInvites.workspaceId, input.workspaceId),
        eq(guestInvites.tokenHash, input.tokenHash),
        liveMember(input.workspaceId, input.at)
      )
    )
    .limit(1);
  return row ?? null;
};

/** Authentication evidence plus CURRENT artifact grant. No audience fallback:
 * even workspace-visible artifacts require an explicit guest grant.
 */
export const findGuestSessionGrant = async (
  db: Database,
  input: {
    artifactId: string;
    tokenHash: string;
    workspaceId: string;
    at: string;
  }
) => {
  const [row] = await db
    .select({
      artifactId: artifactMembers.artifactId,
      expiresAt: artifactMembers.expiresAt,
      guestId: guestIdentities.id,
      memberId: artifactMembers.id,
      role: artifactMembers.role,
      sessionExpiresAt: guestSessions.expiresAt,
      sessionId: guestSessions.id,
      workspaceId: guestSessions.workspaceId,
    })
    .from(guestSessions)
    .innerJoin(guestIdentities, eq(guestIdentities.id, guestSessions.guestId))
    .innerJoin(artifactMembers, eq(artifactMembers.guestId, guestIdentities.id))
    .innerJoin(artifacts, eq(artifacts.id, artifactMembers.artifactId))
    .innerJoin(workspaces, eq(workspaces.id, guestSessions.workspaceId))
    .where(
      and(
        eq(guestSessions.workspaceId, input.workspaceId),
        eq(guestSessions.tokenHash, input.tokenHash),
        gt(guestSessions.expiresAt, input.at),
        eq(artifactMembers.artifactId, input.artifactId),
        liveMember(input.workspaceId, input.at)
      )
    )
    .limit(1);
  return row ?? null;
};

/** Optimistic compare-and-swap assertion, using the existing NOT NULL role
 * constraint (same pattern as artifactQuotaGuard). A competing role/revoke
 * aborts the whole atomic write, including its event and invalidation outbox.
 */
export const guestMemberMutation = (
  db: Database,
  input: {
    before: typeof artifactMembers.$inferSelect;
    role: (typeof artifactMembers.$inferSelect)["role"];
    revokedAt?: string;
    revokedBy?: string;
  }
) =>
  db
    .update(artifactMembers)
    .set({
      role: sql`CASE WHEN ${artifactMembers.role} = ${input.before.role}
    AND ${artifactMembers.revokedAt} IS NULL
    AND ${artifactMembers.expiresAt} IS ${input.before.expiresAt}
    THEN ${input.role} ELSE NULL END`,
      ...(input.revokedAt
        ? { revokedAt: input.revokedAt, revokedBy: input.revokedBy }
        : {}),
    })
    .where(
      and(
        eq(artifactMembers.id, input.before.id),
        eq(artifactMembers.workspaceId, input.before.workspaceId),
        eq(artifactMembers.artifactId, input.before.artifactId)
      )
    );

/** CAS rotation: an old token cannot be renewed or used for a second open.
 * Recheck database access INSIDE the atomic write, so a revoke competing with
 * the preflight cannot produce a successful rotation or view audit.
 */
export const rotateGuestSessionStatement = (
  db: Database,
  input: {
    artifactId: string;
    role: string;
    grantExpiresAt: string;
    at: string;
    expiresAt: string;
    oldHash: string;
    sessionId: string;
    tokenHash: string;
    workspaceId: string;
  }
) =>
  db
    .update(guestSessions)
    .set({
      expiresAt: input.expiresAt,
      lastUsedAt: input.at,
      tokenHash: sql`CASE WHEN ${guestSessions.tokenHash} = ${input.oldHash}
    AND ${guestSessions.expiresAt} > ${input.at}
    AND EXISTS (
      SELECT 1 FROM artifact_members m
      JOIN artifacts a ON a.id = m.artifact_id AND a.workspace_id = m.workspace_id
      JOIN guest_identities g ON g.id = m.guest_id AND g.workspace_id = m.workspace_id
      JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.workspace_id = ${input.workspaceId} AND m.artifact_id = ${input.artifactId}
        AND m.guest_id = ${guestSessions.guestId} AND m.principal_kind = 'guest'
        AND m.user_id IS NULL AND m.revoked_at IS NULL AND m.expires_at > ${input.at}
        AND m.role = ${input.role} AND m.expires_at = ${input.grantExpiresAt}
        AND a.deleted_at IS NULL AND a.kind IN ('document', 'deck')
        AND w.live_guests_enabled = 1
    ) THEN ${input.tokenHash} ELSE NULL END`,
    })
    .where(
      and(
        eq(guestSessions.id, input.sessionId),
        eq(guestSessions.workspaceId, input.workspaceId)
      )
    );

export const deleteGuestSessionStatement = (
  db: Database,
  input: {
    tokenHash: string;
    workspaceId: string;
  }
) =>
  db
    .delete(guestSessions)
    .where(
      and(
        eq(guestSessions.tokenHash, input.tokenHash),
        eq(guestSessions.workspaceId, input.workspaceId)
      )
    );

/** Catch a session deleted between preflight and rotation (zero updated rows).
 * guest identity cannot disappear while the scoped grant still references it.
 */
export const guestSessionRotationGuard = (
  db: Database,
  input: {
    guestId: string;
    sessionId: string;
    tokenHash: string;
    workspaceId: string;
  }
) =>
  db
    .update(guestIdentities)
    .set({
      displayName: sql`CASE WHEN EXISTS (
    SELECT 1 FROM guest_sessions s WHERE s.id = ${input.sessionId}
      AND s.workspace_id = ${input.workspaceId} AND s.guest_id = ${input.guestId}
      AND s.token_hash = ${input.tokenHash}
  ) THEN ${guestIdentities.displayName} ELSE NULL END`,
    })
    .where(
      and(
        eq(guestIdentities.id, input.guestId),
        eq(guestIdentities.workspaceId, input.workspaceId)
      )
    );
