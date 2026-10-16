import { startRunInputSchema } from "@repo/services/runs/types";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

/**
 * What a browser may send: a `ui` session and nothing else. Other origins and
 * `private` belong to in-process callers (Slack, inbox, triggers, routines).
 * Letting a member pick them would let one create a future Slack or inbox
 * session first, as a private one, and the real wake would answer not_found.
 */
const browserStartRunInputSchema = startRunInputSchema.extend({
  session: startRunInputSchema.shape.session
    .pick({ externalKey: true })
    .extend({ origin: z.literal("ui") }),
});

export const runsRouter = router({
  get: workspaceProcedure
    .input(z.strictObject({ runId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.runs.getRun(ctx.principal, input.runId)
    ),
  start: workspaceProcedure
    .input(browserStartRunInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.runs.startRun(ctx.principal, input)
    ),
});
