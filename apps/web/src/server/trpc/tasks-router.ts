import {
  taskGetInputSchema,
  taskListInputSchema,
} from "@repo/services/tasks/service";
import { router, workspaceProcedure } from "./init.ts";

export const tasksRouter = router({
  get: workspaceProcedure
    .input(taskGetInputSchema)
    .query(({ ctx, input }) => ctx.services.tasks.get(ctx.principal, input)),
  list: workspaceProcedure
    .input(taskListInputSchema)
    .query(({ ctx, input }) => ctx.services.tasks.list(ctx.principal, input)),
});
