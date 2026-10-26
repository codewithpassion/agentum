import {
  acceptInputSchema,
  answerInputSchema,
  askInputSchema,
  listInputSchema,
  questionInputSchema,
} from "@repo/services/qa";
import { router, workspaceProcedure } from "./init.ts";

export const qaRouter = router({
  accept: workspaceProcedure
    .input(acceptInputSchema)
    .mutation(({ ctx, input }) => ctx.services.qa.accept(ctx.principal, input)),
  answer: workspaceProcedure
    .input(answerInputSchema)
    .mutation(({ ctx, input }) => ctx.services.qa.answer(ctx.principal, input)),
  ask: workspaceProcedure
    .input(askInputSchema)
    .mutation(({ ctx, input }) => ctx.services.qa.ask(ctx.principal, input)),
  close: workspaceProcedure
    .input(questionInputSchema)
    .mutation(({ ctx, input }) => ctx.services.qa.close(ctx.principal, input)),
  get: workspaceProcedure
    .input(questionInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.qa.get(ctx.principal, input.questionId)
    ),
  list: workspaceProcedure
    .input(listInputSchema)
    .query(({ ctx, input }) => ctx.services.qa.list(ctx.principal, input)),
  openCount: workspaceProcedure.query(({ ctx }) =>
    ctx.services.qa.openCount(ctx.principal)
  ),
});
