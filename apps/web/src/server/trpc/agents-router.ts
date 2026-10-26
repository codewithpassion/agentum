import { agentCreateSchema, agentUpdateSchema } from "@repo/services/agents";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const idInput = z.strictObject({ id: z.string().min(1) });

export const agentsRouter = router({
  archive: workspaceProcedure
    .input(idInput)
    .mutation(({ ctx, input }) =>
      ctx.services.agents.archive(ctx.principal, input.id)
    ),
  checkAddress: workspaceProcedure
    .input(z.strictObject({ local: z.string() }))
    .query(({ ctx, input }) =>
      ctx.services.agents.checkAddress(ctx.principal, input.local)
    ),
  create: workspaceProcedure
    .input(agentCreateSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.agents.create(ctx.principal, input)
    ),
  get: workspaceProcedure
    .input(idInput)
    .query(({ ctx, input }) =>
      ctx.services.agents.get(ctx.principal, input.id)
    ),
  list: workspaceProcedure
    .input(z.strictObject({ includeArchived: z.boolean().optional() }))
    .query(({ ctx, input }) => ctx.services.agents.list(ctx.principal, input)),
  providerKeys: workspaceProcedure.query(({ ctx }) =>
    ctx.services.modelKeys.configuredProviders(ctx.principal)
  ),
  reserveAddress: workspaceProcedure
    .input(z.strictObject({ agentId: z.string().min(1), local: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.services.agents.reserveAddress(
        ctx.principal,
        input.agentId,
        input.local
      )
    ),
  update: workspaceProcedure
    .input(z.strictObject({ id: z.string().min(1), patch: agentUpdateSchema }))
    .mutation(({ ctx, input }) =>
      ctx.services.agents.update(ctx.principal, input.id, input.patch)
    ),
});
