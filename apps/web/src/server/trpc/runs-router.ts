import { startRunInputSchema } from "@repo/services/runs/types";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

export const runsRouter = router({
  get: workspaceProcedure
    .input(z.strictObject({ runId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.runs.getRun(ctx.principal, input.runId)
    ),
  start: workspaceProcedure
    .input(startRunInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.runs.startRun(ctx.principal, input)
    ),
});
