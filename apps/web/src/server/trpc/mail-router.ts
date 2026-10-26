import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const agentInput = z.strictObject({ agentId: z.string().min(1).max(200) });

export const mailRouter = router({
  mailbox: router({
    disable: workspaceProcedure
      .input(agentInput)
      .mutation(({ ctx, input }) =>
        ctx.services.mail.disable(ctx.principal, input.agentId)
      ),
    get: workspaceProcedure
      .input(agentInput)
      .query(({ ctx, input }) =>
        ctx.services.mail.get(ctx.principal, input.agentId)
      ),
    provision: workspaceProcedure
      .input(agentInput)
      .mutation(({ ctx, input }) =>
        ctx.services.mail.provision(ctx.principal, input.agentId)
      ),
  }),
});
