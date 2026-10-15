import { protectedProcedure, router } from "./init.ts";
import { notesRouter } from "./routers/notes.ts";

export const appRouter = router({
  /** The caller's user id. The example protected procedure. */
  me: protectedProcedure.query(({ ctx }) => ({ userId: ctx.userId })),
  notes: notesRouter,
});

export type AppRouter = typeof appRouter;
