// Machine procedures: a user enrols, lists and revokes the machines of their workspace and attaches a computer to an agent.
import { PRODUCTS } from "@repo/protocol/releases";
import { enrollTokenInputSchema } from "@repo/services/machines";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

export const machinesRouter = router({
  attachComputer: workspaceProcedure
    .input(
      z.strictObject({
        agentId: z.string().min(1),
        machineId: z.string().min(1).nullable(),
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.machines.attachComputer(
        ctx.principal,
        input.agentId,
        input.machineId
      )
    ),
  createEnrollToken: workspaceProcedure
    .input(enrollTokenInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.machines.createEnrollToken(ctx.principal, input)
    ),
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.services.machines.list(ctx.principal)
  ),
  newestDaemonVersion: workspaceProcedure
    .input(z.enum(PRODUCTS).optional())
    .query(({ ctx, input }) =>
      ctx.services.machines.newestDaemonVersion(ctx.principal, input)
    ),
  outdatedDaemonVersions: workspaceProcedure
    .input(
      z.strictObject({
        product: z.enum(PRODUCTS).optional(),
        versions: z.array(z.string().max(100)).max(100),
      })
    )
    .query(({ ctx, input }) =>
      ctx.services.machines.outdatedVersionsAmong(
        ctx.principal,
        input.versions,
        input.product
      )
    ),
  revoke: workspaceProcedure
    .input(z.strictObject({ machineId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.machines.revoke(ctx.principal, input.machineId)
    ),
});
