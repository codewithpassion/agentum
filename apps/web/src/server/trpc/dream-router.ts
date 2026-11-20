import {
  dreamAgentInputSchema,
  dreamAnswerInputSchema,
  dreamDecideInputSchema,
  dreamRunIdInputSchema,
} from "@repo/services/dream";
import { router, workspaceProcedure } from "./init.ts";

export const dreamRouter = router({
  answer: workspaceProcedure
    .input(dreamAnswerInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.dream.answer(ctx.principal, input)
    ),
  changes: workspaceProcedure
    .input(dreamRunIdInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.dream.changes(ctx.principal, input.dreamRunId)
    ),
  decide: workspaceProcedure
    .input(dreamDecideInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.dream.decide(ctx.principal, input)
    ),
  get: workspaceProcedure
    .input(dreamRunIdInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.dream.get(ctx.principal, input.dreamRunId)
    ),
  list: workspaceProcedure
    .input(dreamAgentInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.dream.list(ctx.principal, input.agentId)
    ),
  runNow: workspaceProcedure
    .input(dreamAgentInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.dream.runNow(ctx.principal, input.agentId)
    ),
  undo: workspaceProcedure
    .input(dreamRunIdInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.dream.undo(ctx.principal, input.dreamRunId)
    ),
});
