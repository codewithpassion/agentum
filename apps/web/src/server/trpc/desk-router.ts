import { deskInputSchema } from "@repo/services/desk";
import { router, workspaceProcedure } from "./init.ts";

export const deskRouter = router({
  get: workspaceProcedure
    .input(deskInputSchema)
    .query(({ ctx, input }) => ctx.services.desk.get(ctx.principal, input)),
  needsYouCount: workspaceProcedure.query(({ ctx }) =>
    ctx.services.desk.needsYouCount(ctx.principal)
  ),
});
