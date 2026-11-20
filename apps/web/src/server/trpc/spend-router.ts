import {
  byAgentInputSchema,
  resumeInputSchema,
  setCapInputSchema,
  spendRangeSchema,
} from "@repo/services/spend";
import { router, workspaceProcedure } from "./init.ts";

export const spendRouter = router({
  byAgent: workspaceProcedure
    .input(byAgentInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.spend.byAgent(ctx.principal, input.agentId, {
        from: input.from,
        to: input.to,
      })
    ),
  caps: workspaceProcedure.query(({ ctx }) =>
    ctx.services.spend.caps(ctx.principal)
  ),
  resume: workspaceProcedure
    .input(resumeInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.spend.resume(ctx.principal, input)
    ),
  setCap: workspaceProcedure
    .input(setCapInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.spend.setCap(ctx.principal, input)
    ),
  workspace: workspaceProcedure
    .input(spendRangeSchema)
    .query(({ ctx, input }) =>
      ctx.services.spend.workspace(ctx.principal, input)
    ),
});
