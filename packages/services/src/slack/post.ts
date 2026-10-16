import type { Clock } from "../runs/types.ts";
import type { SlackCallResult } from "./client.ts";

const MAX_ATTEMPTS = 3;
const TRANSIENT_BACKOFF_MS = 500;
/** A reply is posted from a request that is still open, so a long wait is cut. */
const MAX_WAIT_MS = 5000;
const MS_PER_SECOND = 1000;

/**
 * Runs a Slack call up to three times. A 429 waits for Slack's
 * `Retry-After` (at most 5 s here) and a transient failure waits half a
 * second times the attempt number. A config or rejected result will not get
 * better, so it comes back at once.
 */
export const withRetry = async <T extends object>(
  clock: Clock,
  call: () => Promise<SlackCallResult<T>>
): Promise<SlackCallResult<T>> => {
  let result = await call();
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (result.kind !== "rate_limited" && result.kind !== "transient") {
      return result;
    }
    const waitMs =
      result.kind === "rate_limited"
        ? Math.min(result.retryAfterSeconds * MS_PER_SECOND, MAX_WAIT_MS)
        : TRANSIENT_BACKOFF_MS * attempt;
    // biome-ignore lint/performance/noAwaitInLoops: each try waits for the one before
    await clock.sleep(waitMs);
    result = await call();
  }
  return result;
};

/** A one-line reason for a Slack call that did not work, for events and logs. */
export const describeFailure = (
  result: Exclude<SlackCallResult, { kind: "ok" }>
): string => (result.kind === "rate_limited" ? "ratelimited" : result.error);
