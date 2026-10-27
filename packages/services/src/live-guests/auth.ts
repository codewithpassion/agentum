import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import {
  attemptGuestCode,
  findGuestActiveCode,
  findGuestAuthInvitation,
  type GuestAuthInvitation,
  guestCodeAttemptGuard,
  issueGuestCode,
  reserveGuestRateBucket,
  supersedeGuestCodes,
} from "@repo/db/live-guest-auth";
import { guestInvites, guestSessions } from "@repo/db/schema/live-artifacts";
import { guestGrantSchema } from "@repo/protocol/live";
import { and, eq, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { cutUserAgent, truncateIp } from "../artifacts/view-privacy.ts";
import { constantTimeEqual, hashToken } from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import type { Clock } from "../runs/types.ts";
import type { GuestEmailPort } from "./ports.ts";
import {
  createGuestCodeHasher,
  createGuestRateHasher,
  GUEST_CODE_SECONDS,
  GUEST_SESSION_SECONDS,
  guestSessionCookie,
  newGuestCode,
  newGuestSessionToken,
} from "./security.ts";

const INVITE = /^hm_invite_[A-Za-z0-9_-]{43}$/;
const CODE = /^\d{6}$/;
const encoder = new TextEncoder();
const refusal = () => new ServiceError("not_found", "Guest access unavailable");
const accepted = () => ({ accepted: true as const });
/** Fixed-window ceilings. A single atomic write reserves every bucket. */
export const GUEST_SEND_LIMITS = [
  { kind: "invite", limit: 1, seconds: 60 },
  { kind: "invite", limit: 3, seconds: 3600 },
  { kind: "email", limit: 6, seconds: 3600 },
  { kind: "ip_prefix", limit: 30, seconds: 3600 },
] as const;

interface AuthInput {
  inviteToken: string;
  workspaceId: string;
}
/** IP must come from trusted HTTP/platform metadata, never a submitted form.
 * No full IP is persisted. Missing/invalid IPs cannot request codes.
 */
export interface GuestRequestCodeInput extends AuthInput {
  ip: string;
}
export interface GuestVerifyInput extends AuthInput {
  code: string;
  ip?: string;
  userAgent?: string;
}
export interface GuestAuthDeps {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  email: GuestEmailPort;
  events: Pick<EventsService, "insertStatement">;
  guestsOff: () => boolean;
  /** Trusted profile lookup, not an application Principal/authentication port. */
  inviterName: (input: {
    userId: string;
    workspaceId: string;
  }) => Promise<string>;
  /** Private environment secret, not an invite/user supplied key. Never logged. */
  pepper: Uint8Array<ArrayBuffer>;
}

export const createGuestAuthService = async (deps: GuestAuthDeps) => {
  const hashCode = await createGuestCodeHasher(deps.pepper);
  const hashRate = await createGuestRateHasher(deps.pepper);
  const { db, atomic, clock } = deps;
  const audit = (
    invite: GuestAuthInvitation,
    type: "artifact.guest_code_sent" | "artifact.guest_signed_in"
  ) =>
    deps.events.insertStatement({
      actor: { id: invite.inviterId, kind: "user" },
      payload: {
        artifactId: invite.artifactId,
        guestId: invite.guestId,
        memberId: invite.memberId,
      },
      type,
      workspaceId: invite.workspaceId,
    });
  const rateStatements = async (
    invite: GuestAuthInvitation,
    ipPrefix: string,
    at: Date
  ) => {
    const subjects = {
      email: invite.email,
      invite: invite.inviteId,
      ip_prefix: ipPrefix,
    };
    const pending = await Promise.all(
      GUEST_SEND_LIMITS.map(async (policy) => {
        const windowStart =
          Math.floor(at.getTime() / 1000 / policy.seconds) * policy.seconds;
        return {
          statement: reserveGuestRateBucket(db, {
            count: 1,
            expiresAt: new Date(
              (windowStart + policy.seconds) * 1000
            ).toISOString(),
            id: ulid(),
            kind: policy.kind,
            limit: policy.limit,
            subjectHash: await hashRate({
              ...policy,
              subject: subjects[policy.kind],
              workspaceId: invite.workspaceId,
            }),
            windowStart,
            workspaceId: invite.workspaceId,
          }),
        };
      })
    );
    return pending.map((entry) => entry.statement);
  };
  const sendCode = async (input: GuestRequestCodeInput) => {
    const ipPrefix = truncateIp(input.ip);
    if (deps.guestsOff() || !INVITE.test(input.inviteToken) || !ipPrefix) {
      return;
    }
    const at = clock.now();
    const invite = await findGuestAuthInvitation(db, {
      at: at.toISOString(),
      tokenHash: await hashToken(input.inviteToken),
      workspaceId: input.workspaceId,
    });
    if (!invite) {
      return;
    }
    const code = newGuestCode();
    const id = ulid();
    const expiresAt = new Date(
      at.getTime() + GUEST_CODE_SECONDS * 1000
    ).toISOString();
    const codeHash = await hashCode(code, {
      codeId: id,
      guestId: invite.guestId,
      inviteId: invite.inviteId,
      workspaceId: invite.workspaceId,
    });
    const inviterName = await deps.inviterName({
      userId: invite.inviterId,
      workspaceId: invite.workspaceId,
    });
    const reservations = await rateStatements(invite, ipPrefix, at);
    if (deps.guestsOff()) {
      return;
    }
    await atomic([
      ...reservations,
      supersedeGuestCodes(db, invite, at.toISOString()),
      issueGuestCode(db, invite, {
        attempts: 0,
        codeHash,
        createdAt: at.toISOString(),
        expiresAt,
        guestId: invite.guestId,
        id,
        inviteId: invite.inviteId,
        workspaceId: invite.workspaceId,
      }),
      audit(invite, "artifact.guest_code_sent"),
    ]);
    // Reserve before delivery. A failed send remains charged; retries require a
    // fresh bounded request. Audit records the committed send request, not SMTP delivery.
    await deps.email.sendCode({
      artifactTitle: invite.artifactTitle,
      code,
      codeExpiresAt: expiresAt,
      expiresAt: invite.grantExpiresAt,
      inviterName,
      role: invite.role,
      to: invite.email,
      workspaceName: invite.workspaceName,
    });
  };
  const verify = async (input: GuestVerifyInput) => {
    if (deps.guestsOff() || !INVITE.test(input.inviteToken)) {
      throw refusal();
    }
    const at = clock.now();
    const found = await findGuestActiveCode(db, {
      at: at.toISOString(),
      tokenHash: await hashToken(input.inviteToken),
      workspaceId: input.workspaceId,
    });
    if (!found) {
      throw refusal();
    }
    // Validate the returned capability before any consumption/session/audit write.
    const grant = guestGrantSchema.parse({
      artifactId: found.artifactId,
      expiresAt: found.grantExpiresAt,
      guestId: found.guestId,
      role: found.role,
      workspaceId: found.workspaceId,
    });
    const codeHash = await hashCode(
      CODE.test(input.code) ? input.code : "000000",
      {
        codeId: found.code.id,
        guestId: found.guestId,
        inviteId: found.inviteId,
        workspaceId: found.workspaceId,
      }
    );
    const matches =
      CODE.test(input.code) &&
      constantTimeEqual(
        encoder.encode(codeHash),
        encoder.encode(found.code.codeHash)
      );
    const credential = matches ? await newGuestSessionToken() : null;
    const expiresAt = new Date(
      at.getTime() + GUEST_SESSION_SECONDS * 1000
    ).toISOString();
    const statements: Statement[] = [
      attemptGuestCode(db, {
        at: at.toISOString(),
        codeHash: found.code.codeHash,
        codeId: found.code.id,
        invite: found,
        matches,
      }),
      guestCodeAttemptGuard(db, {
        at: at.toISOString(),
        codeId: found.code.id,
        guestId: found.guestId,
        matches,
        workspaceId: found.workspaceId,
      }),
    ];
    if (credential) {
      statements.push(
        db.insert(guestSessions).values({
          createdAt: at.toISOString(),
          expiresAt,
          guestId: found.guestId,
          id: ulid(),
          ipPrefix: input.ip ? truncateIp(input.ip) : null,
          lastUsedAt: at.toISOString(),
          tokenHash: credential.hash,
          userAgent: cutUserAgent(input.userAgent),
          workspaceId: found.workspaceId,
        }),
        db
          .update(guestInvites)
          .set({
            usedAt: sql`coalesce(${guestInvites.usedAt}, ${at.toISOString()})`,
          })
          .where(
            and(
              eq(guestInvites.id, found.inviteId),
              eq(guestInvites.workspaceId, found.workspaceId)
            )
          ),
        audit(found, "artifact.guest_signed_in")
      );
    }
    if (deps.guestsOff()) {
      throw refusal();
    }
    await atomic(statements);
    if (!credential) {
      throw refusal();
    }
    return {
      cookie: guestSessionCookie(credential.token),
      expiresAt,
      grant,
      location: `/g/a/${found.artifactId}`,
    };
  };
  return {
    /** Scanner-safe invitation GET belongs to the access reader. Only this
     * explicit POST-like action generates/sends a code. Response never reveals
     * whether the token/address exists, is limited/expired/off, or email failed.
     */
    async requestCode(input: GuestRequestCodeInput) {
      try {
        await sendCode(input);
      } catch {
        /* Uniform response, no secrets in logs. */
      }
      return accepted();
    },
    async verify(input: GuestVerifyInput) {
      try {
        return await verify(input);
      } catch {
        // biome-ignore lint/style/useErrorCause: uniform public refusal must not expose SQL/credentials
        throw refusal();
      }
    },
  };
};
