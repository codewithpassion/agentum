import { protectedProcedure, router } from "./init.ts";

export const appRouter = router({
  /** The caller's user id. The example protected procedure. */
  me: protectedProcedure.query(({ ctx }) => ({ userId: ctx.userId })),
});

export type AppRouter = typeof appRouter;
