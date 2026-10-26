import {
  createInputSchema,
  discardInputSchema,
  dryRunInputSchema,
  saveDraftInputSchema,
} from "@repo/services/agent-builder/lifecycle";
import { draftInputSchema } from "@repo/services/agent-builder/service";
import { router, workspaceProcedure } from "./init.ts";

export const agentBuilderRouter = router({
  catalog: workspaceProcedure.query(({ ctx }) =>
    ctx.services.agentBuilder.catalog(ctx.principal)
  ),
  create: workspaceProcedure
    .input(createInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.agentBuilder.create(ctx.principal, input)
    ),
  discard: workspaceProcedure
    .input(discardInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.agentBuilder.discard(ctx.principal, input.draftAgentId)
    ),
  draft: workspaceProcedure
    .input(draftInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.agentBuilder.draft(ctx.principal, input)
    ),
  dryRun: workspaceProcedure
    .input(dryRunInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.agentBuilder.dryRun(ctx.principal, input)
    ),
  saveDraft: workspaceProcedure
    .input(saveDraftInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.agentBuilder.saveDraft(ctx.principal, input)
    ),
});
