import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const inputSchema = z.strictObject({ requestId: z.string().min(1).max(200) });
export const takeoverRouter = router({
  cancel: workspaceProcedure
    .input(inputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.takeover.cancel(ctx.principal, input.requestId)
    ),
  handBack: workspaceProcedure
    .input(inputSchema.extend({ note: z.string().optional() }))
    .mutation(({ ctx, input }) =>
      ctx.services.takeover.handBack(ctx.principal, input.requestId, input.note)
    ),
  take: workspaceProcedure
    .input(inputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.takeover.take(ctx.principal, input.requestId)
    ),
});
