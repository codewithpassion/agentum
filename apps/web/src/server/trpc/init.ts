import { isForbiddenError } from "@repo/services/authz";
import { isServiceError, type ServiceErrorCode } from "@repo/services/errors";
import { initTRPC, TRPCError } from "@trpc/server";
import type { Context } from "./context.ts";

const t = initTRPC.context<Context>().create({
  // A failed input check carries the schema library's issue list as its
  // message. Send the first issue's text instead, so the UI can show it.
  errorFormatter: ({ shape, error }) => {
    const cause: unknown = error.cause;
    if (
      error.code === "BAD_REQUEST" &&
      typeof cause === "object" &&
      cause !== null &&
      "issues" in cause &&
      Array.isArray(cause.issues)
    ) {
      const [first] = cause.issues as { message?: unknown }[];
      if (typeof first?.message === "string") {
        return { ...shape, message: first.message };
      }
    }
    // Unexpected errors can carry internals (SQL, binding names). Keep their
    // text in development, hide it in production; server.ts logs it.
    if (error.code === "INTERNAL_SERVER_ERROR" && !import.meta.env.DEV) {
      return { ...shape, message: "Internal server error" };
    }
    return shape;
  },
  // tRPC's own default reads process.env.NODE_ENV, which a Worker may not
  // set, and would then send stack traces to production clients.
  isDev: import.meta.env.DEV,
});

export const { mergeRouters, router } = t;

const TRPC_CODE_FOR: Record<ServiceErrorCode, TRPCError["code"]> = {
  conflict: "CONFLICT",
  invalid: "BAD_REQUEST",
  not_found: "NOT_FOUND",
};

/**
 * Turns the errors services throw into tRPC codes. tRPC wraps a thrown error
 * in a TRPCError and keeps the original in `cause`. Anything else passes
 * through, so it still reaches the errorFormatter as an internal error.
 */
const mapServiceErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (result.ok) {
    return result;
  }
  const { cause } = result.error;
  if (isForbiddenError(cause)) {
    throw new TRPCError({ cause, code: "FORBIDDEN", message: cause.message });
  }
  if (isServiceError(cause)) {
    throw new TRPCError({
      cause,
      code: TRPC_CODE_FOR[cause.code],
      message: cause.message,
    });
  }
  return result;
});

/** Anyone, signed in or not. `ctx.principal` may be null. */
export const publicProcedure = t.procedure;

/**
 * A signed-in user with an active allowed organisation. Narrows
 * `ctx.principal` to the user principal. Everyone else gets 401.
 */
export const workspaceProcedure = t.procedure
  .use(mapServiceErrors)
  .use(({ ctx, next }) => {
    if (ctx.principal?.kind !== "user") {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    return next({ ctx: { ...ctx, principal: ctx.principal } });
  });
