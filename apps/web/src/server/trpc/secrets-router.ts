import { secretCreateSchema, secretUpdateSchema } from "@repo/services/secrets";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const idString = z.string().min(1).max(200);

/**
 * Workspace secrets. Nothing here returns a value: a secret is written once
 * and replaced, never read back.
 */
export const secretsRouter = router({
  create: workspaceProcedure
    .input(secretCreateSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.secrets.create(ctx.principal, input)
    ),
  grants: workspaceProcedure
    .input(z.strictObject({ agentId: idString }))
    .query(({ ctx, input }) =>
      ctx.services.secrets.grantsOf(ctx.principal, input.agentId)
    ),
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.services.secrets.list(ctx.principal)
  ),
  remove: workspaceProcedure
    .input(z.strictObject({ id: idString }))
    .mutation(({ ctx, input }) =>
      ctx.services.secrets.remove(ctx.principal, input.id)
    ),
  setGrants: workspaceProcedure
    .input(
      z.strictObject({
        agentId: idString,
        secretIds: z.array(idString).max(100),
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.secrets.setGrants(
        ctx.principal,
        input.agentId,
        input.secretIds
      )
    ),
  update: workspaceProcedure
    .input(z.strictObject({ id: idString, patch: secretUpdateSchema }))
    .mutation(({ ctx, input }) =>
      ctx.services.secrets.update(ctx.principal, input.id, input.patch)
    ),
});
