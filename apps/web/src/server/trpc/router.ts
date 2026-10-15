import { agentsRouter } from "./agents-router.ts";
import { router, workspaceProcedure } from "./init.ts";
import { runsRouter } from "./runs-router.ts";

export const appRouter = router({
  agents: agentsRouter,
  /**
   * The caller's user id and workspace id. The example workspace procedure:
   * it answers 401 unless the caller is a user in an allowed organisation.
   */
  me: workspaceProcedure.query(({ ctx }) => ({
    userId: ctx.principal.userId,
    workspaceId: ctx.principal.workspaceId,
  })),
  runs: runsRouter,
});

export type AppRouter = typeof appRouter;
