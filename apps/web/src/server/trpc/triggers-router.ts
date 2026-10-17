// Trigger procedures: a user makes, lists, pauses and revokes the HTTP triggers of their workspace, and approves or rejects the ones an agent proposed.
import {
  triggerCreateInputSchema,
  triggerListInputSchema,
  triggerSetEnabledInputSchema,
} from "@repo/services/triggers";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const triggerIdInput = z.strictObject({ triggerId: z.string().min(1) });

export const triggersRouter = router({
  approve: workspaceProcedure
    .input(triggerIdInput)
    .mutation(({ ctx, input }) =>
      ctx.services.triggers.approve(ctx.principal, input.triggerId)
    ),
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
  reject: workspaceProcedure
    .input(triggerIdInput)
    .mutation(({ ctx, input }) =>
      ctx.services.triggers.reject(ctx.principal, input.triggerId)
    ),
  revoke: workspaceProcedure
    .input(triggerIdInput)
    .mutation(({ ctx, input }) =>
      ctx.services.triggers.revoke(ctx.principal, input.triggerId)
    ),
  setEnabled: workspaceProcedure
    .input(triggerSetEnabledInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.triggers.setEnabled(ctx.principal, input)
    ),
});
