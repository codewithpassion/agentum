import { deskInputSchema } from "@repo/services/desk";
import {
  clearAttentionInputSchema,
  railInputSchema,
} from "@repo/services/rail";
import { router, workspaceProcedure } from "./init.ts";

export const deskRouter = router({
  clearAttention: workspaceProcedure
    .input(clearAttentionInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.rail.clearAttention(ctx.principal, input.runId)
    ),
  get: workspaceProcedure
    .input(deskInputSchema)
    .query(({ ctx, input }) => ctx.services.desk.get(ctx.principal, input)),
  needsYouCount: workspaceProcedure.query(({ ctx }) =>
    ctx.services.desk.needsYouCount(ctx.principal)
  ),
  rail: workspaceProcedure
    .input(railInputSchema)
    .query(({ ctx, input }) => ctx.services.rail.get(ctx.principal, input)),
});
