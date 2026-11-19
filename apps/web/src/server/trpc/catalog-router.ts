import { catalogAddInputSchema } from "@repo/services/catalog";
import { router, workspaceProcedure } from "./init.ts";

export const catalogRouter = router({
  add: workspaceProcedure
    .input(catalogAddInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.catalog.add(ctx.principal, input.key)
    ),
  list: workspaceProcedure.query(({ ctx }) => ctx.services.catalog.list()),
});
