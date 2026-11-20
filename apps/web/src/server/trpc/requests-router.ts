import {
  answerDecisionsInputSchema,
  dismissDecisionsInputSchema,
  pendingInputSchema,
  ruleKeyInputSchema,
  ruleSetInputSchema,
  rulesListInputSchema,
  webAnswerInputSchema,
} from "@repo/services/requests";
import { router, workspaceProcedure } from "./init.ts";

export const requestsRouter = router({
  answer: workspaceProcedure
    .input(webAnswerInputSchema)
    .mutation(({ ctx, input: { requestId, ...answer } }) =>
      ctx.services.requests.answer(ctx.principal, {
        answer,
        requestId,
        via: "web",
      })
    ),
  answerDecisions: workspaceProcedure
    .input(answerDecisionsInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.requests.answerDecisions(ctx.principal, input)
    ),
  dismissDecisions: workspaceProcedure
    .input(dismissDecisionsInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.requests.dismissDecisions(ctx.principal, input)
    ),
  pending: workspaceProcedure
    .input(pendingInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.requests.listPending(ctx.principal, input)
    ),
  rules: router({
    list: workspaceProcedure
      .input(rulesListInputSchema)
      .query(({ ctx, input }) =>
        ctx.services.requests.listRules(ctx.principal, input)
      ),
    remove: workspaceProcedure
      .input(ruleKeyInputSchema)
      .mutation(({ ctx, input }) =>
        ctx.services.requests.removeRule(ctx.principal, input)
      ),
    set: workspaceProcedure
      .input(ruleSetInputSchema)
      .mutation(({ ctx, input }) =>
        ctx.services.requests.setRule(ctx.principal, input)
      ),
  }),
});
