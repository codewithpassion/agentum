import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

export const managedKeysRouter = router({
  remove: workspaceProcedure.mutation(({ ctx }) =>
    ctx.services.managedKeys.remove(ctx.principal)
  ),
  set: workspaceProcedure
    .input(z.strictObject({ apiKey: z.string().min(1).max(512) }))
    .mutation(({ ctx, input }) =>
      ctx.services.managedKeys.set(ctx.principal, input)
    ),
  status: workspaceProcedure.query(({ ctx }) =>
    ctx.services.managedKeys.status(ctx.principal)
  ),
});
