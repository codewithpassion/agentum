import { router, workspaceProcedure } from "./init.ts";

export const rosterRouter = router({
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.services.roster.list(ctx.principal)
  ),
});
