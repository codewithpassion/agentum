import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

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
});
