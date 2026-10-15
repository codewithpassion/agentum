import { router, workspaceProcedure } from "./init.ts";

export const appRouter = router({
  /**
   * The caller's user id and workspace id. The example workspace procedure:
   * it answers 401 unless the caller is a user in an allowed organisation.
   */
  me: workspaceProcedure.query(({ ctx }) => ({
    userId: ctx.principal.userId,
    workspaceId: ctx.principal.workspaceId,
  })),
});

export type AppRouter = typeof appRouter;
