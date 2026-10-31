import { ToolError } from "@repo/mcp/result";
import { isA2aRateLimitError } from "@repo/services/a2a/errors";
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import { ZodError } from "zod";

/** The service errors an agent can act on, as tool errors. Anything else passes through. */
const toToolError = (error: unknown): unknown => {
  if (isForbiddenError(error)) {
    return new ToolError("forbidden", "This credential may not do that.");
  }
  if (isA2aRateLimitError(error)) {
    return new ToolError(
      "conflict",
      `${error.message} Try again in about ${error.retryAfterSeconds} seconds.`
    );
  }
  if (isServiceError(error)) {
    const code = error.code === "invalid" ? "validation" : error.code;
    return new ToolError(code, error.message);
  }
  if (error instanceof ZodError) {
    // A service's own input check: its first message says what to fix.
    return new ToolError(
      "validation",
      error.issues[0]?.message ?? "The input is not valid."
    );
  }
  return error;
};

/** Runs `work`, turning the errors a tool may show into `ToolError`. */
export const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw toToolError(error);
  }
};
