import { draftInputSchema } from "@repo/services/agent-builder/service";
import { router, workspaceProcedure } from "./init.ts";

export const agentBuilderRouter = router({
  catalog: workspaceProcedure.query(({ ctx }) =>
    ctx.services.agentBuilder.catalog(ctx.principal)
  ),
  draft: workspaceProcedure
    .input(draftInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.agentBuilder.draft(ctx.principal, input)
    ),
});
