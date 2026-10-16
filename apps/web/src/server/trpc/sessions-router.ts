import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

export const sessionsRouter = router({
  list: workspaceProcedure
    .input(z.strictObject({ agentId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.sessions.list(ctx.principal, input)
    ),
  transcript: workspaceProcedure
    .input(z.strictObject({ sessionId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.sessions.transcript(ctx.principal, input.sessionId)
    ),
});
