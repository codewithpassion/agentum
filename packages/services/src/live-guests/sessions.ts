/** Session lifecycle after OTP sign-in from auth.ts. No route or runtime
 * composes this module until phase 3 integration is explicitly enabled.
 */
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import {
  deleteGuestSessionStatement,
  findGuestSessionRotationGrant,
  guestSessionRotationGuard,
  guestViewOnRotation,
  rotateGuestSessionStatement,
} from "@repo/db/live-guests";
import { guestGrantSchema } from "@repo/protocol/live";
import { ulid } from "ulidx";
import { hashToken } from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import type { Clock } from "../runs/types.ts";
import {
  clearGuestSessionCookie,
  GUEST_PREVIOUS_TOKEN_GRACE_SECONDS,
  GUEST_SESSION_SECONDS,
  guestSessionCookie,
  isGuestSessionToken,
  newGuestSessionToken,
} from "./security.ts";

const refused = () => new ServiceError("not_found", "Guest access unavailable");
interface SessionInput {
  artifactId: string;
  sessionToken: string;
  workspaceId: string;
}
/** Privacy-normalized metadata from the trusted HTTP adapter, never a full IP. */
export interface GuestOpenMetadata {
  asn?: string;
  asOrg?: string;
  city?: string;
  country?: string;
  ipPrefix?: string;
  referrerHost?: string;
  region?: string;
  userAgent?: string;
}
export const createGuestSessionLifecycle = (deps: {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  guestsOff: () => boolean;
}) => {
  const rotate = async (input: SessionInput, metadata?: GuestOpenMetadata) => {
    if (deps.guestsOff() || !isGuestSessionToken(input.sessionToken)) {
      throw refused();
    }
    const at = deps.clock.now();
    const oldHash = await hashToken(input.sessionToken);
    const row = await findGuestSessionRotationGrant(deps.db, {
      artifactId: input.artifactId,
      at: at.toISOString(),
      tokenHash: oldHash,
      workspaceId: input.workspaceId,
    });
    if (!row) {
      throw refused();
    }
    const grant = guestGrantSchema.parse({
      artifactId: row.artifactId,
      expiresAt: row.expiresAt,
      guestId: row.guestId,
      role: row.role,
      workspaceId: row.workspaceId,
    });
    const credential = await newGuestSessionToken();
    const expiresAt = new Date(
      at.getTime() + GUEST_SESSION_SECONDS * 1000
    ).toISOString();
    const previousValidUntil = new Date(
      at.getTime() + GUEST_PREVIOUS_TOKEN_GRACE_SECONDS * 1000
    ).toISOString();
    if (deps.guestsOff()) {
      throw refused();
    }
    try {
      await deps.atomic([
        rotateGuestSessionStatement(deps.db, {
          artifactId: input.artifactId,
          at: at.toISOString(),
          expiresAt,
          grantExpiresAt: grant.expiresAt,
          oldHash,
          previousValidUntil,
          role: grant.role,
          sessionId: row.sessionId,
          tokenHash: credential.hash,
          workspaceId: input.workspaceId,
        }),
        guestSessionRotationGuard(deps.db, {
          guestId: row.guestId,
          sessionId: row.sessionId,
          tokenHash: credential.hash,
          workspaceId: row.workspaceId,
        }),
        ...(metadata
          ? [
              guestViewOnRotation(deps.db, {
                oldHash,
                sessionId: row.sessionId,
                tokenHash: credential.hash,
                view: {
                  artifactId: row.artifactId,
                  asn: metadata.asn,
                  asOrg: metadata.asOrg,
                  city: metadata.city,
                  country: metadata.country,
                  createdAt: at.toISOString(),
                  guestId: row.guestId,
                  id: ulid(),
                  ipPrefix: metadata.ipPrefix,
                  outcome: "ok",
                  referrerHost: metadata.referrerHost,
                  region: metadata.region,
                  surface: "guest",
                  userAgent: metadata.userAgent,
                  workspaceId: row.workspaceId,
                },
              }),
            ]
          : []),
      ]);
    } catch {
      // biome-ignore lint/style/useErrorCause: public refusal must not expose SQL or credential data
      throw refused();
    }
    return { cookie: guestSessionCookie(credential.token), expiresAt, grant };
  };
  return {
    /** Explicit open records one view atomically with rotating the cookie. */
    open: (input: SessionInput, metadata: GuestOpenMetadata = {}) =>
      rotate(input, metadata),
    renew: (input: SessionInput) => rotate(input),
    /** Sign-out works even when guest access has been disabled. */
    async signout(input: { sessionToken: string; workspaceId: string }) {
      if (isGuestSessionToken(input.sessionToken)) {
        await deps.atomic([
          deleteGuestSessionStatement(deps.db, {
            at: deps.clock.now().toISOString(),
            tokenHash: await hashToken(input.sessionToken),
            workspaceId: input.workspaceId,
          }),
        ]);
      }
      return { cookie: clearGuestSessionCookie() };
    },
  };
};
