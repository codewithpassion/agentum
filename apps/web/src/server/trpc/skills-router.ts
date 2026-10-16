// Skills procedures: the skills an agent has, and a new skill for it.
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const agentInput = z.strictObject({ agentId: z.string().min(1) });

export const skillsRouter = router({
  create: workspaceProcedure
    .input(
      z.strictObject({ agentId: z.string().min(1), name: z.string().min(1) })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.skills.create(ctx.principal, input.agentId, input.name)
    ),
  list: workspaceProcedure
    .input(agentInput)
    .query(({ ctx, input }) =>
      ctx.services.skills.catalog(ctx.principal, input.agentId)
    ),
});
