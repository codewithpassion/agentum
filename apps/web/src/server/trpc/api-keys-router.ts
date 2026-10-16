// API key procedures: a user mints, lists and revokes the keys of their workspace.
import { apiKeyCreateInputSchema } from "@repo/services/api-keys";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

export const apiKeysRouter = router({
  create: workspaceProcedure
    .input(apiKeyCreateInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.apiKeys.create(ctx.principal, input)
    ),
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.services.apiKeys.list(ctx.principal)
  ),
  revoke: workspaceProcedure
    .input(z.strictObject({ keyId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.apiKeys.revoke(ctx.principal, input.keyId)
    ),
});
