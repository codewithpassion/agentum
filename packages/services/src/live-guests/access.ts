/** Read-side building block, deliberately not a sign-in/renewal service. */
import type { Database } from "@repo/db";
import {
  findGuestInvitation,
  findGuestSessionGrant,
} from "@repo/db/live-guests";
import { type GuestGrant, guestGrantSchema } from "@repo/protocol/live";
import { hashToken } from "../crypto.ts";
import type { Clock } from "../runs/types.ts";

const INVITE = /^hm_invite_[A-Za-z0-9_-]{43}$/;
const SESSION = /^hm_guest_[A-Za-z0-9_-]{43}$/;

export const createGuestAccessReader = (deps: {
  clock: Clock;
  db: Database;
  /** Read on EVERY call; the future adapter supplies LIVE_GUESTS_OFF semantics. */
  guestsOff: () => boolean;
}) => ({
  async invitation(workspaceId: string, token: string) {
    if (deps.guestsOff() || !INVITE.test(token)) {
      return null;
    }
    return await findGuestInvitation(deps.db, {
      at: deps.clock.now().toISOString(),
      tokenHash: await hashToken(token),
      workspaceId,
    });
  },
  /** Returns a distinct GuestGrant, never a Principal. Call for each request.
   * The eventual service must atomically rotate the session and record opens;
   * this reader performs neither operation and must not be wired to routes.
   */
  async resolve(input: {
    artifactId: string;
    sessionToken: string;
    workspaceId: string;
  }): Promise<GuestGrant | null> {
    if (deps.guestsOff() || !SESSION.test(input.sessionToken)) {
      return null;
    }
    const row = await findGuestSessionGrant(deps.db, {
      artifactId: input.artifactId,
      at: deps.clock.now().toISOString(),
      tokenHash: await hashToken(input.sessionToken),
      workspaceId: input.workspaceId,
    });
    if (!row) {
      return null;
    }
    const parsed = guestGrantSchema.safeParse({
      artifactId: row.artifactId,
      expiresAt: row.expiresAt,
      guestId: row.guestId,
      role: row.role,
      workspaceId: row.workspaceId,
    });
    return parsed.success ? parsed.data : null;
  },
});
