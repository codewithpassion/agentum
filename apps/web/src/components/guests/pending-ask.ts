import { guestAskSchema } from "@repo/protocol/guest";
import type { GuestGrant } from "@repo/protocol/live";

const PREFIX = "agentum:guest-ask:";
export const pendingAskKey = (grant: GuestGrant) =>
  `${PREFIX}${JSON.stringify([grant.workspaceId, grant.guestId, grant.artifactId])}`;

export const readPendingAsk = (key: string) => {
  try {
    const value = guestAskSchema.safeParse(
      JSON.parse(sessionStorage.getItem(key) ?? "null")
    );
    return value.success ? value.data : undefined;
  } catch {
    // Storage can be unavailable or contain an older invalid draft.
  }
};

/** An old acknowledgement must not erase a newer draft at the same scope. */
export const clearPendingAsk = (key: string, requestId: string) => {
  try {
    if (readPendingAsk(key)?.requestId === requestId) {
      sessionStorage.removeItem(key);
    }
  } catch {
    // Storage is optional; the mounted composer still retains retry identity.
  }
};

/** Clear every artifact, including legacy unscoped drafts, on signout. */
export const clearGuestAsks = () => {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (
        key.startsWith(PREFIX) ||
        (key.startsWith("/api/guest/artifacts/") && key.endsWith("/ask"))
      ) {
        sessionStorage.removeItem(key);
      }
    }
  } catch {
    // Storage may be disabled.
  }
};
