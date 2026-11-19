import {
  draftInputSchema,
  forAgentInputSchema,
  runNowInputSchema,
} from "@repo/services/jobs";
import { router, workspaceProcedure } from "./init.ts";

export const jobsRouter = router({
  draft: workspaceProcedure
    .input(draftInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.jobs.draft(ctx.principal, input.agentId, input.text)
    ),
  forAgent: workspaceProcedure
    .input(forAgentInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.jobs.forAgent(ctx.principal, input.agentId)
    ),
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.services.jobs.list(ctx.principal)
  ),
  runNow: workspaceProcedure
    .input(runNowInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.jobs.runNow(ctx.principal, input.jobId)
    ),
});
