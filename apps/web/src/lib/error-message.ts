import { TRPCClientError } from "@trpc/client";

/** The text of a caught value for the UI: an Error's message, otherwise the fallback. */
export const errorMessage = (
  error: unknown,
  fallback = "Something went wrong."
): string => (error instanceof Error ? error.message : fallback);

/**
 * Why a service refused, as the server reports it in `data.reason` (see
 * `ERROR_REASON` in `@repo/services/errors`). Null for anything else. Act on
 * this and never on the wording of the message.
 */
export const errorReason = (error: unknown): string | null => {
  if (!(error instanceof TRPCClientError)) {
    return null;
  }
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null || !("reason" in data)) {
    return null;
  }
  return typeof data.reason === "string" ? data.reason : null;
};
