import { guestCommentSchema } from "@repo/protocol/guest";
import type { GuestGrant } from "@repo/protocol/live";
import { pendingAskKey } from "./pending-ask";
/** Keep the controller's signout prefix so clearing all guest asks also clears
 * comment retries, while the full identity/artifact tuple prevents draft reuse. */
export const pendingCommentKey = (grant: GuestGrant) =>
  `${pendingAskKey(grant)}:comment`;
export const readPendingComment = (key: string) => {
  try {
    const parsed = guestCommentSchema.safeParse(
      JSON.parse(sessionStorage.getItem(key) ?? "null")
    );
    return parsed.success &&
      parsed.data.toAgent &&
      parsed.data.requestId &&
      !parsed.data.threadId
      ? parsed.data
      : undefined;
  } catch {
    /* Optional storage. */
  }
};
export const clearPendingComment = (key: string, requestId: string) => {
  try {
    if (readPendingComment(key)?.requestId === requestId) {
      sessionStorage.removeItem(key);
    }
  } catch {
    /* Optional storage. */
  }
};
