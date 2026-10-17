// Routine procedures: a user makes, lists, pauses and removes the routines of their workspace, and approves or rejects the ones an agent proposed.
import {
  routineCreateInputSchema,
  routineListInputSchema,
  routineSetEnabledInputSchema,
} from "@repo/services/routines";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const routineIdInput = z.strictObject({
  routineId: z.string().min(1).max(200),
});

export const routinesRouter = router({
  approve: workspaceProcedure
    .input(routineIdInput)
    .mutation(({ ctx, input }) =>
      ctx.services.routines.approve(ctx.principal, input.routineId)
    ),
  create: workspaceProcedure
    .input(routineCreateInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.routines.create(ctx.principal, input)
    ),
  list: workspaceProcedure
    .input(routineListInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.routines.list(ctx.principal, input)
    ),
  reject: workspaceProcedure
    .input(routineIdInput)
    .mutation(({ ctx, input }) =>
      ctx.services.routines.reject(ctx.principal, input.routineId)
    ),
  remove: workspaceProcedure
    .input(routineIdInput)
    .mutation(({ ctx, input }) =>
      ctx.services.routines.remove(ctx.principal, input.routineId)
    ),
  setEnabled: workspaceProcedure
    .input(routineSetEnabledInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.routines.setEnabled(ctx.principal, input)
    ),
});
