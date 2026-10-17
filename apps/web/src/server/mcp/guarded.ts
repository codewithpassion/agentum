import { ToolError } from "@repo/mcp/result";
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";

/** The service errors an agent can act on, as tool errors. Anything else passes through. */
const toToolError = (error: unknown): unknown => {
  if (isForbiddenError(error)) {
    return new ToolError("forbidden", "This credential may not do that.");
  }
  if (isServiceError(error)) {
    const code = error.code === "invalid" ? "validation" : error.code;
    return new ToolError(code, error.message);
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
