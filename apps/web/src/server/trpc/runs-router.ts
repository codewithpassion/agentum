import { startRunInputSchema } from "@repo/services/runs/types";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

/**
 * What a browser may send: a `ui` session and nothing else. Other origins,
 * `private` and `reply` belong to in-process callers (Slack, inbox, triggers,
 * routines). Letting a member pick an origin or `private` would let one create
 * a future Slack or inbox session first, as a private one, and the real wake
 * would answer not_found. A `reply` target would post the answer into any
 * inbox thread or Slack thread of the workspace.
 */
const browserStartRunInputSchema = startRunInputSchema
  .omit({ reply: true })
  .extend({
    session: startRunInputSchema.shape.session
      .pick({ externalKey: true })
      .extend({ origin: z.literal("ui") }),
  });

export const runsRouter = router({
  cancel: workspaceProcedure
    .input(z.strictObject({ runId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.runs.cancelRun(ctx.principal, input.runId)
    ),
  get: workspaceProcedure
    .input(z.strictObject({ runId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.runs.getRun(ctx.principal, input.runId)
    ),
  /** A reply in a sub-thread: a thread an agent's hand-off started. */
  reply: workspaceProcedure
    .input(
      z.strictObject({
        input: browserStartRunInputSchema.shape.input,
        requestId: z.string().min(1).max(200).optional(),
        sessionId: z.string().min(1),
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.runs.replyInSubThread(ctx.principal, input)
    ),
  start: workspaceProcedure
    .input(browserStartRunInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.runs.startRun(ctx.principal, input)
    ),
});
