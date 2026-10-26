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
  mailToday: workspaceProcedure.query(({ ctx }) =>
    ctx.services.mail.today(ctx.principal)
  ),
  setTrigger: workspaceProcedure
    .input(agentInput.extend({ on: z.boolean() }))
    .mutation(({ ctx, input }) =>
      ctx.services.mail.setTrigger(ctx.principal, input.agentId, input.on)
    ),
  thread: workspaceProcedure
    .input(z.strictObject({ id: z.string().min(1).max(200) }))
    .query(({ ctx, input }) =>
      ctx.services.mail.thread(ctx.principal, input.id)
    ),
  threadForTask: workspaceProcedure
    .input(z.strictObject({ taskId: z.string().min(1).max(200) }))
    .query(({ ctx, input }) =>
      ctx.services.mail.threadForTask(ctx.principal, input.taskId)
    ),
  threads: workspaceProcedure
    .input(agentInput)
    .query(({ ctx, input }) =>
      ctx.services.mail.threads(ctx.principal, input.agentId)
    ),
});
