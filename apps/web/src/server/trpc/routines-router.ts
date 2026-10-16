// Routine procedures: a user makes, lists, pauses and removes the routines of their workspace.
import {
  routineCreateInputSchema,
  routineListInputSchema,
  routineSetEnabledInputSchema,
} from "@repo/services/routines";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

export const routinesRouter = router({
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
  remove: workspaceProcedure
    .input(z.strictObject({ routineId: z.string().min(1).max(200) }))
    .mutation(({ ctx, input }) =>
      ctx.services.routines.remove(ctx.principal, input.routineId)
    ),
  setEnabled: workspaceProcedure
    .input(routineSetEnabledInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.routines.setEnabled(ctx.principal, input)
    ),
});
