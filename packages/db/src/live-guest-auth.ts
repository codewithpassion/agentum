/** Durable OTP issuance/verification statements. Always combine the returned
 * writes with their session/event writes through atomic; never execute a subset.
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "./database.ts";
import { artifacts } from "./schema/artifacts.ts";
import {
  artifactMembers,
  guestAuthRateBuckets,
  guestCodes,
  guestIdentities,
  guestInvites,
} from "./schema/live-artifacts.ts";
import { workspaces } from "./schema/workspaces.ts";

/** Every parent must match workspace AND identity, not just its foreign-key ID. */
const liveInvite = (workspaceId: string, at: string) =>
  and(
    eq(guestInvites.workspaceId, workspaceId),
    eq(artifactMembers.workspaceId, workspaceId),
    eq(artifactMembers.principalKind, "guest"),
    isNull(artifactMembers.userId),
    isNull(artifactMembers.revokedAt),
    gt(artifactMembers.expiresAt, at),
    eq(guestIdentities.workspaceId, workspaceId),
    eq(artifacts.workspaceId, workspaceId),
    isNull(artifacts.deletedAt),
    sql`${artifacts.kind} IN ('document', 'deck')`,
    eq(workspaces.liveGuestsEnabled, true)
  );
const selection = {
  artifactId: artifacts.id,
  artifactTitle: artifacts.title,
  email: guestIdentities.email,
  grantExpiresAt: artifactMembers.expiresAt,
  guestId: guestIdentities.id,
  inviteId: guestInvites.id,
  inviterId: artifactMembers.createdBy,
  memberId: artifactMembers.id,
  role: artifactMembers.role,
  workspaceId: guestInvites.workspaceId,
  workspaceName: workspaces.name,
};
export const findGuestAuthInvitation = async (
  db: Database,
  input: { workspaceId: string; tokenHash: string; at: string }
) => {
  const [row] = await db
    .select(selection)
    .from(guestInvites)
    .innerJoin(artifactMembers, eq(artifactMembers.id, guestInvites.memberId))
    .innerJoin(guestIdentities, eq(guestIdentities.id, artifactMembers.guestId))
    .innerJoin(artifacts, eq(artifacts.id, artifactMembers.artifactId))
    .innerJoin(workspaces, eq(workspaces.id, guestInvites.workspaceId))
    .where(
      and(
        eq(guestInvites.tokenHash, input.tokenHash),
        liveInvite(input.workspaceId, input.at)
      )
    )
    .limit(1);
  return row ?? null;
};
export type GuestAuthInvitation = NonNullable<
  Awaited<ReturnType<typeof findGuestAuthInvitation>>
>;

export const findGuestActiveCode = async (
  db: Database,
  input: { workspaceId: string; tokenHash: string; at: string }
) => {
  const [row] = await db
    .select({ ...selection, code: guestCodes })
    .from(guestInvites)
    .innerJoin(artifactMembers, eq(artifactMembers.id, guestInvites.memberId))
    .innerJoin(guestIdentities, eq(guestIdentities.id, artifactMembers.guestId))
    .innerJoin(artifacts, eq(artifacts.id, artifactMembers.artifactId))
    .innerJoin(workspaces, eq(workspaces.id, guestInvites.workspaceId))
    .innerJoin(
      guestCodes,
      and(
        eq(guestCodes.inviteId, guestInvites.id),
        eq(guestCodes.guestId, guestIdentities.id)
      )
    )
    .where(
      and(
        eq(guestInvites.tokenHash, input.tokenHash),
        liveInvite(input.workspaceId, input.at),
        eq(guestCodes.workspaceId, input.workspaceId),
        isNull(guestCodes.consumedAt),
        gt(guestCodes.expiresAt, input.at),
        sql`${guestCodes.attempts} < 5`
      )
    )
    .limit(1);
  return row ?? null;
};

/** SQL assertion reused during each write, so revocation/switch/deletion races
 * cannot issue a usable challenge or session after the preflight read. */
const eligibleInvitation = (
  invite: GuestAuthInvitation,
  at: string
) => sql`EXISTS (
  SELECT 1 FROM guest_invites i
  JOIN artifact_members m ON m.id = i.member_id AND m.workspace_id = i.workspace_id
  JOIN guest_identities g ON g.id = m.guest_id AND g.workspace_id = m.workspace_id
  JOIN artifacts a ON a.id = m.artifact_id AND a.workspace_id = m.workspace_id
  JOIN workspaces w ON w.id = i.workspace_id
  WHERE i.id = ${invite.inviteId} AND i.workspace_id = ${invite.workspaceId}
    AND m.id = ${invite.memberId} AND m.guest_id = ${invite.guestId}
    AND g.email = ${invite.email} AND a.id = ${invite.artifactId}
    AND m.principal_kind = 'guest' AND m.user_id IS NULL
    AND m.revoked_at IS NULL AND m.expires_at > ${at}
    AND m.role = ${invite.role} AND m.expires_at = ${invite.grantExpiresAt}
    AND a.deleted_at IS NULL AND a.kind IN ('document', 'deck') AND w.live_guests_enabled = 1
)`;

export const reserveGuestRateBucket = (
  db: Database,
  bucket: typeof guestAuthRateBuckets.$inferInsert
) =>
  db
    .insert(guestAuthRateBuckets)
    .values(bucket)
    .onConflictDoUpdate({
      set: {
        count: sql`${guestAuthRateBuckets.count} + 1`,
        // A configuration change cannot silently relax an already-open window.
        limit: sql`min(${guestAuthRateBuckets.limit}, excluded."limit")`,
      },
      target: [
        guestAuthRateBuckets.workspaceId,
        guestAuthRateBuckets.kind,
        guestAuthRateBuckets.subjectHash,
        guestAuthRateBuckets.windowStart,
      ],
    });

export const supersedeGuestCodes = (
  db: Database,
  invite: GuestAuthInvitation,
  at: string
) =>
  db
    .update(guestCodes)
    .set({ consumedAt: at })
    .where(
      and(
        eq(guestCodes.workspaceId, invite.workspaceId),
        eq(guestCodes.inviteId, invite.inviteId),
        isNull(guestCodes.consumedAt)
      )
    );
export const issueGuestCode = (
  db: Database,
  invite: GuestAuthInvitation,
  code: typeof guestCodes.$inferInsert
) =>
  db.insert(guestCodes).values({
    ...code,
    codeHash: sql`CASE WHEN ${eligibleInvitation(invite, code.createdAt)} THEN ${code.codeHash} ELSE NULL END`,
  });

/** Charge a try and, on success/fifth failure, consume it in the SAME statement.
 * The NOT NULL attempts/check constraints abort stale, replayed or sixth tries.
 * Failed guesses commit their increment; only correct guesses add a session.
 */
export const attemptGuestCode = (
  db: Database,
  input: {
    invite: GuestAuthInvitation;
    codeId: string;
    codeHash: string;
    at: string;
    matches: boolean;
  }
) =>
  db
    .update(guestCodes)
    .set({
      attempts: sql`CASE WHEN ${guestCodes.consumedAt} IS NULL
    AND ${guestCodes.attempts} < 5 AND ${guestCodes.expiresAt} > ${input.at}
    AND ${guestCodes.codeHash} = ${input.codeHash}
    AND ${guestCodes.inviteId} = ${input.invite.inviteId}
    AND ${guestCodes.guestId} = ${input.invite.guestId}
    AND ${eligibleInvitation(input.invite, input.at)}
    THEN ${guestCodes.attempts} + 1 ELSE NULL END`,
      // SET expressions see the old attempts count, on both SQLite and D1.
      consumedAt: sql`CASE WHEN ${input.matches ? 1 : 0} OR ${guestCodes.attempts} >= 4 THEN ${input.at} ELSE NULL END`,
    })
    .where(
      and(
        eq(guestCodes.id, input.codeId),
        eq(guestCodes.workspaceId, input.invite.workspaceId)
      )
    );

/** Detect zero-row attempts (e.g. external deletion after preflight). Attach to
 * the same atomic batch immediately after the attempt, before session/event.
 * For wrong guesses, attempts must have advanced. For success, consumedAt must
 * be set; the serialized attempt statement above is what ensures single-use.
 */
export const guestCodeAttemptGuard = (
  db: Database,
  input: {
    guestId: string;
    workspaceId: string;
    codeId: string;
    at: string;
    matches: boolean;
  }
) =>
  db
    .update(guestIdentities)
    .set({
      displayName: sql`CASE WHEN EXISTS (
    SELECT 1 FROM guest_codes c WHERE c.id = ${input.codeId}
      AND c.workspace_id = ${input.workspaceId} AND c.guest_id = ${input.guestId}
      AND c.attempts > 0 AND (${input.matches ? 0 : 1} OR c.consumed_at = ${input.at})
  ) THEN ${guestIdentities.displayName} ELSE NULL END`,
      lastSeenAt: input.matches ? input.at : guestIdentities.lastSeenAt,
    })
    .where(
      and(
        eq(guestIdentities.id, input.guestId),
        eq(guestIdentities.workspaceId, input.workspaceId)
      )
    );
