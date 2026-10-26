import { taskFilesInputSchema } from "@repo/services/library/task-files";
import {
  taskGetInputSchema,
  taskListInputSchema,
} from "@repo/services/tasks/service";
import { router, workspaceProcedure } from "./init.ts";

export const tasksRouter = router({
  files: workspaceProcedure
    .input(taskFilesInputSchema)
    .query(({ ctx, input }) => ctx.services.tasks.files(ctx.principal, input)),
  get: workspaceProcedure
    .input(taskGetInputSchema)
    .query(({ ctx, input }) => ctx.services.tasks.get(ctx.principal, input)),
  list: workspaceProcedure
    .input(taskListInputSchema)
    .query(({ ctx, input }) => ctx.services.tasks.list(ctx.principal, input)),
});
