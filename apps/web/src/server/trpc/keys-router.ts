import { forAgentInputSchema } from "@repo/services/keys";
import { router, workspaceProcedure } from "./init.ts";

export const keysRouter = router({
  forAgent: workspaceProcedure
    .input(forAgentInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.keys.forAgent(ctx.principal, input.agentId)
    ),
});
