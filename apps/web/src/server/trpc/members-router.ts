import { router, workspaceProcedure } from "./init.ts";

export const membersRouter = router({
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.services.members.list(ctx.principal)
  ),
});
