/** Read-side guest authentication queries. All references are tenant-joined,
 * including foreign keys: the L.1 foreign keys themselves are not composite.
 * Mutations return unexecuted statements for the service atomic write.
 */
import { and, eq, gt, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import type { Database } from "./database.ts";
import { artifacts, artifactViews } from "./schema/artifacts.ts";
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
const findSessionGrant = async (
  db: Database,
  input: {
    artifactId: string;
    workspaceId: string;
    at: string;
  },
  credential: SQL
) => {
  const [row] = await db
    .select({
      artifactId: artifactMembers.artifactId,
      createdBy: artifactMembers.createdBy,
      expiresAt: artifactMembers.expiresAt,
      guestId: guestIdentities.id,
      guestName: guestIdentities.displayName,
      memberId: artifactMembers.id,
      role: artifactMembers.role,
      sessionExpiresAt: guestSessions.expiresAt,
      sessionId: guestSessions.id,
      workspaceId: guestSessions.workspaceId,
      workspaceName: workspaces.name,
    })
    .from(guestSessions)
    .innerJoin(guestIdentities, eq(guestIdentities.id, guestSessions.guestId))
    .innerJoin(artifactMembers, eq(artifactMembers.guestId, guestIdentities.id))
    .innerJoin(artifacts, eq(artifacts.id, artifactMembers.artifactId))
    .innerJoin(workspaces, eq(workspaces.id, guestSessions.workspaceId))
    .where(
      and(
        eq(guestSessions.workspaceId, input.workspaceId),
        credential,
        gt(guestSessions.expiresAt, input.at),
        eq(artifactMembers.artifactId, input.artifactId),
        liveMember(input.workspaceId, input.at)
      )
    )
    .limit(1);
  return row ?? null;
};

/** Rotation alone also admits the immediately previous token, while its grace
 * lasts, so a guest whose rotation response was lost can recover. Every other
 * reader uses `findGuestSessionGrant` and refuses it. The grant, role, expiry
 * and switch checks are the same joins either way. */
export const findGuestSessionRotationGrant = (
  db: Database,
  input: {
    artifactId: string;
    workspaceId: string;
    at: string;
    tokenHash: string;
  }
) =>
  findSessionGrant(
    db,
    input,
    or(
      eq(guestSessions.tokenHash, input.tokenHash),
      and(
        eq(guestSessions.previousTokenHash, input.tokenHash),
        gt(guestSessions.previousValidUntil, input.at)
      )
    ) as SQL
  );

/** Browser HTTP authentication requires the current rotating token. */
export const findGuestSessionGrant = (
  db: Database,
  input: {
    artifactId: string;
    workspaceId: string;
    at: string;
    tokenHash: string;
  }
) => findSessionGrant(db, input, eq(guestSessions.tokenHash, input.tokenHash));
/** Socket references validate the persisted session in one query, independently
 * of concurrent HTTP token rotation. Signout/expiry still invalidate the row. */
export const findGuestSessionReferenceGrant = (
  db: Database,
  input: {
    artifactId: string;
    workspaceId: string;
    at: string;
    sessionId: string;
  }
) => findSessionGrant(db, input, eq(guestSessions.id, input.sessionId));

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

/** CAS rotation. The presented token must be the current one, or the previous
 * one inside its grace; the replaced current token becomes the new previous, so
 * the session always accepts the latest token and the one before it, and no
 * older one. Recheck database access INSIDE the atomic write, so a revoke
 * competing with the preflight cannot produce a successful rotation or view
 * audit.
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
    previousValidUntil: string;
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
      previousTokenHash: sql`${guestSessions.tokenHash}`,
      previousValidUntil: input.previousValidUntil,
      tokenHash: sql`CASE WHEN (${guestSessions.tokenHash} = ${input.oldHash}
      OR (${guestSessions.previousTokenHash} = ${input.oldHash}
        AND ${guestSessions.previousValidUntil} > ${input.at}))
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

/** Signing out with the previous token inside its grace ends the session too,
 * for a guest who lost the response that carried the current one. */
export const deleteGuestSessionStatement = (
  db: Database,
  input: {
    at: string;
    tokenHash: string;
    workspaceId: string;
  }
) =>
  db
    .delete(guestSessions)
    .where(
      and(
        or(
          eq(guestSessions.tokenHash, input.tokenHash),
          and(
            eq(guestSessions.previousTokenHash, input.tokenHash),
            gt(guestSessions.previousValidUntil, input.at)
          )
        ),
        eq(guestSessions.workspaceId, input.workspaceId)
      )
    );

/** One view row, only when this very write rotated from the current token.
 * A recovery from the previous token repeats an open that already audited. */
export const guestViewOnRotation = (
  db: Database,
  input: {
    oldHash: string;
    sessionId: string;
    tokenHash: string;
    view: typeof artifactViews.$inferInsert;
  }
) => {
  const v = input.view;
  return db.insert(artifactViews).select(
    db
      .select({
        artifactId: sql<string>`${v.artifactId}`.as("artifactId"),
        asn: sql<string | null>`${v.asn ?? null}`.as("asn"),
        asOrg: sql<string | null>`${v.asOrg ?? null}`.as("asOrg"),
        city: sql<string | null>`${v.city ?? null}`.as("city"),
        country: sql<string | null>`${v.country ?? null}`.as("country"),
        createdAt: sql<string>`${v.createdAt}`.as("createdAt"),
        durationMs: sql<null>`NULL`.as("durationMs"),
        guestId: sql<string | null>`${v.guestId ?? null}`.as("guestId"),
        id: sql<string>`${v.id}`.as("id"),
        ipPrefix: sql<string | null>`${v.ipPrefix ?? null}`.as("ipPrefix"),
        outcome: sql<string>`${v.outcome}`.as("outcome"),
        referrerHost: sql<string | null>`${v.referrerHost ?? null}`.as(
          "referrerHost"
        ),
        region: sql<string | null>`${v.region ?? null}`.as("region"),
        shareId: sql<string | null>`NULL`.as("shareId"),
        statusCode: sql<null>`NULL`.as("statusCode"),
        surface: sql<string>`${v.surface}`.as("surface"),
        toolKey: sql<string | null>`NULL`.as("toolKey"),
        userAgent: sql<string | null>`${v.userAgent ?? null}`.as("userAgent"),
        userId: sql<string | null>`NULL`.as("userId"),
        versionId: sql<string | null>`NULL`.as("versionId"),
        visitorHash: sql<string | null>`NULL`.as("visitorHash"),
        workspaceId: sql<string>`${v.workspaceId}`.as("workspaceId"),
      })
      .from(sql`(select 1)`)
      .where(
        sql`EXISTS (SELECT 1 FROM guest_sessions s WHERE s.id = ${input.sessionId}
      AND s.token_hash = ${input.tokenHash} AND s.previous_token_hash = ${input.oldHash})`
      )
  );
};

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

/** Write-time authorization assertion on the non-null artifact title. This is
 * intentionally a no-op on success; a competing revoke/expiry rolls back the
 * entire guest mutation rather than leaving a comment/file without authority. */
export const guestArtifactWriteGuard = (
  db: Database,
  input: {
    workspaceId: string;
    artifactId: string;
    guestId: string;
    tokenHash: string;
    at: string;
    role: string;
  }
) =>
  db
    .update(artifacts)
    .set({
      title: sql`CASE WHEN EXISTS (
  SELECT 1 FROM guest_sessions s
  JOIN guest_identities g ON g.id = s.guest_id AND g.workspace_id = s.workspace_id
  JOIN artifact_members m ON m.guest_id = g.id AND m.workspace_id = g.workspace_id
  JOIN workspaces w ON w.id = m.workspace_id
  WHERE s.workspace_id = ${input.workspaceId} AND s.token_hash = ${input.tokenHash}
    AND s.guest_id = ${input.guestId} AND s.expires_at > ${input.at}
    AND m.artifact_id = ${input.artifactId} AND m.principal_kind = 'guest'
    AND m.user_id IS NULL AND m.revoked_at IS NULL AND m.expires_at > ${input.at}
    AND m.role = ${input.role} AND m.role IN ('commenter', 'editor')
    AND w.live_guests_enabled = 1
    AND ${artifacts.deletedAt} IS NULL AND ${artifacts.kind} IN ('document', 'deck')
  ) THEN ${artifacts.title} ELSE NULL END`,
    })
    .where(
      and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.workspaceId, input.workspaceId)
      )
    );
