// Machine procedures: a user enrols, lists and revokes the machines of their workspace.
import { enrollTokenInputSchema } from "@repo/services/machines";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

export const machinesRouter = router({
  createEnrollToken: workspaceProcedure
    .input(enrollTokenInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.machines.createEnrollToken(ctx.principal, input)
    ),
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.services.machines.list(ctx.principal)
  ),
  revoke: workspaceProcedure
    .input(z.strictObject({ machineId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.machines.revoke(ctx.principal, input.machineId)
    ),
});
