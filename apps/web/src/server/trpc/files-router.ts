import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const DESCRIBE_MAX_IDS = 100;

export const filesRouter = router({
  /** Copies a library file into a new file a message can attach. */
  attachFromLibrary: workspaceProcedure
    .input(z.strictObject({ path: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.libraryLinks.attach(ctx.principal, input.path)
    ),
  /** Names, sizes and types of files, for the chips in the chat. */
  describe: workspaceProcedure
    .input(
      z.strictObject({
        fileIds: z.array(z.string().min(1)).max(DESCRIBE_MAX_IDS),
      })
    )
    .query(({ ctx, input }) =>
      ctx.services.files.describe(ctx.principal, input.fileIds)
    ),
  /** Copies a file's bytes into the library at `path`. */
  saveToLibrary: workspaceProcedure
    .input(
      z.strictObject({ fileId: z.string().min(1), path: z.string().min(1) })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.libraryLinks.save(ctx.principal, input.fileId, input.path)
    ),
});
