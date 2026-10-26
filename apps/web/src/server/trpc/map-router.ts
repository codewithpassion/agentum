import { mapGraphInputSchema } from "@repo/services/map";
import { router, workspaceProcedure } from "./init.ts";

export const mapRouter = router({
  graph: workspaceProcedure
    .input(mapGraphInputSchema)
    .query(({ ctx, input }) => ctx.services.map.graph(ctx.principal, input)),
});
