import { StaleAncestryError } from "@repo/live-deck/migrations";
import { DocumentError } from "@repo/live-doc";
import { DECK_STALE_ANCESTRY } from "@repo/protocol/deck";

/** The reason a room sends in its `error` control before it closes a socket. */
export function rejectionMessage(error: unknown): string {
  if (error instanceof StaleAncestryError) {
    return DECK_STALE_ANCESTRY;
  }
  if (error instanceof DocumentError) {
    return error.code;
  }
  if (error instanceof Error) {
    if (error.message === "Document exceeds 8 MiB") {
      return error.message;
    }
    if (error.message.startsWith("/")) {
      return error.message.slice(0, 4096);
    }
  }
  return "Rejected message";
}
