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

export const { router } = t;

/** Anyone, signed in or not. `ctx.userId` may be null. */
export const publicProcedure = t.procedure;

/** Signed-in users only. Narrows `ctx.userId` to a string. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});
