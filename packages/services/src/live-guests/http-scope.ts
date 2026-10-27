/** Private HTTP scope discovery. Never turn a guest credential into a Principal. */
import type { Database } from "@repo/db";
import { artifacts } from "@repo/db/schema/artifacts";
import { guestInvites, guestSessions } from "@repo/db/schema/live-artifacts";
import { eq } from "drizzle-orm";
import { hashToken } from "../crypto.ts";

const INVITATION = /^hm_invite_[A-Za-z0-9_-]{43}$/;
const SESSION = /^hm_guest_[A-Za-z0-9_-]{43}$/;

export const createGuestScopeDiscovery = (db: Database) => ({
  async artifact(artifactId: string) {
    const [row] = await db
      .select({ workspaceId: artifacts.workspaceId })
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .limit(1);
    return row?.workspaceId ?? null;
  },
  async invitation(token: string) {
    if (!INVITATION.test(token)) {
      return null;
    }
    const [row] = await db
      .select({ workspaceId: guestInvites.workspaceId })
      .from(guestInvites)
      .where(eq(guestInvites.tokenHash, await hashToken(token)))
      .limit(1);
    return row?.workspaceId ?? null;
  },
  async session(token: string) {
    if (!SESSION.test(token)) {
      return null;
    }
    const [row] = await db
      .select({ workspaceId: guestSessions.workspaceId })
      .from(guestSessions)
      .where(eq(guestSessions.tokenHash, await hashToken(token)))
      .limit(1);
    return row?.workspaceId ?? null;
  },
});
