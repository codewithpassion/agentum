// What a thrown error becomes on the `/a2a` routes, before either binding
// words it. The two bindings share this so one refusal reads the same on both.
import type { ErrorName, ErrorOptions } from "@repo/a2a/errors";
import { isA2aRateLimitError, isA2aTaskError } from "@repo/services/a2a/errors";
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import { z } from "zod";

export type Refusal =
  /** No usable credential for this path, or the connection ended. Never says which. */
  | { kind: "unauthorized" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "error"; name: ErrorName; options: ErrorOptions };

export const UNAUTHORIZED_MESSAGE = "Authentication is required.";
export const RATE_LIMITED_MESSAGE = "This connection is over its hourly limit.";
const INTERNAL_MESSAGE = "Something went wrong on our side.";

const describeIssue = (error: z.ZodError): string => {
  const [issue] = error.issues;
  if (!issue) {
    return "The request is not valid.";
  }
  const path = issue.path.join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
};

const refuse = (name: ErrorName, message?: string): Refusal => ({
  kind: "error",
  name,
  options: message === undefined ? {} : { message },
});

/**
 * A service refusal as a `Refusal`. A `ForbiddenError` from a peer's own call
 * means its connection ended after the request was authenticated, so it is the
 * same 401 as a bad token. Anything unknown is a bug: it is logged and the peer
 * gets a generic error with none of the internals.
 */
export const classify = (error: unknown): Refusal => {
  if (isA2aTaskError(error)) {
    return refuse(error.errorName, error.message);
  }
  if (isA2aRateLimitError(error)) {
    return { kind: "rate_limited", retryAfterSeconds: error.retryAfterSeconds };
  }
  if (isForbiddenError(error)) {
    return { kind: "unauthorized" };
  }
  if (isServiceError(error)) {
    return error.code === "not_found"
      ? refuse("TaskNotFoundError", error.message)
      : refuse("InvalidParamsError", error.message);
  }
  if (error instanceof z.ZodError) {
    return refuse("InvalidParamsError", describeIssue(error));
  }
  console.error("A2A request failed", error);
  return refuse("InternalError", INTERNAL_MESSAGE);
};
