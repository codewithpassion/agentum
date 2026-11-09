import { startRunInputSchema } from "@repo/services/runs/types";
import { TRPCError } from "@trpc/server";
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
  start: workspaceProcedure
    .input(browserStartRunInputSchema)
    .mutation(({ ctx, input }) => {
      // `main:<userId>` is a person's main thread, made by `sessions.main`.
      const key = input.session.externalKey;
      if (key?.startsWith("main:") && key !== `main:${ctx.principal.userId}`) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "That session key is reserved",
        });
      }
      return ctx.services.runs.startRun(ctx.principal, input);
    }),
});
