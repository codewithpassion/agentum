/**
 * What the inbound tasks service refuses with when the A2A spec has a name for
 * it. The routes (AA.4) map `errorName` to the JSON-RPC and HTTP+JSON errors of
 * `@repo/a2a/errors`. Anything else the service refuses is a `ServiceError`
 * (`invalid` is `InvalidParamsError`) or a `ForbiddenError`.
 */
import type { A2aErrorName } from "@repo/a2a/errors";

export class A2aTaskError extends Error {
  override readonly name = "A2aTaskError";
  readonly errorName: A2aErrorName;

  constructor(errorName: A2aErrorName, message: string) {
    super(message);
    this.errorName = errorName;
  }
}

export const isA2aTaskError = (error: unknown): error is A2aTaskError =>
  error instanceof A2aTaskError;

/**
 * The connection is over its hourly limit. The HTTP layer answers 429 and sends
 * `retryAfterSeconds` as `Retry-After`.
 */
export class A2aRateLimitError extends Error {
  override readonly name = "A2aRateLimitError";
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("This connection is over its hourly limit of tasks.");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const isA2aRateLimitError = (
  error: unknown
): error is A2aRateLimitError => error instanceof A2aRateLimitError;
