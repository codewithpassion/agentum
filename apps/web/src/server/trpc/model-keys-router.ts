import { MODEL_PROVIDERS } from "@repo/db/shared";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const providerInput = z.enum(MODEL_PROVIDERS);

export const modelKeysRouter = router({
  remove: workspaceProcedure
    .input(z.strictObject({ provider: providerInput }))
    .mutation(({ ctx, input }) =>
      ctx.services.modelKeys.remove(ctx.principal, input.provider)
    ),
  set: workspaceProcedure
    .input(
      z.strictObject({
        apiKey: z.string().min(1).max(512),
        provider: providerInput,
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.modelKeys.set(ctx.principal, input)
    ),
  status: workspaceProcedure
    .input(z.strictObject({ provider: providerInput }))
    .query(({ ctx, input }) =>
      ctx.services.modelKeys.status(ctx.principal, input.provider)
    ),
});
