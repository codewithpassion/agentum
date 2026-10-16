// Trigger procedures: a user makes, lists and revokes the HTTP triggers of their workspace.
import {
  triggerCreateInputSchema,
  triggerListInputSchema,
} from "@repo/services/triggers";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

export const triggersRouter = router({
  create: workspaceProcedure
    .input(triggerCreateInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.triggers.create(ctx.principal, input)
    ),
  list: workspaceProcedure
    .input(triggerListInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.triggers.list(ctx.principal, input)
    ),
  revoke: workspaceProcedure
    .input(z.strictObject({ triggerId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.triggers.revoke(ctx.principal, input.triggerId)
    ),
});
