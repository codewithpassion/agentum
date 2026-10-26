import { suggestionDecisionSchema } from "@repo/services/wiki/suggestions";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const suggestionsRouter = router({
  decide: workspaceProcedure
    .input(
      z.union([
        suggestionDecisionSchema.options[0].extend({ id: z.string().min(1) }),
        suggestionDecisionSchema.options[1].extend({ id: z.string().min(1) }),
      ])
    )
    .mutation(({ ctx, input: { id, ...decision } }) =>
      ctx.services.wikiSuggestions.decide(ctx.principal, id, decision)
    ),
  get: workspaceProcedure
    .input(z.strictObject({ id: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.wikiSuggestions.get(ctx.principal, input.id)
    ),
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.services.wikiSuggestions.list(ctx.principal)
  ),
});

export const wikiRouter = router({
  createPage: workspaceProcedure
    .input(z.strictObject({ parent: z.string().optional(), title: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.services.wiki.createPage(ctx.principal, input.title, input.parent)
    ),
  page: workspaceProcedure
    .input(z.strictObject({ path: z.string() }))
    .query(({ ctx, input }) =>
      ctx.services.wiki.page(ctx.principal, input.path)
    ),
  pages: workspaceProcedure.query(({ ctx }) =>
    ctx.services.wiki.pages(ctx.principal)
  ),
  suggestions: suggestionsRouter,
});
