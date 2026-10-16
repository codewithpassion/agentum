import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const DESCRIBE_MAX_IDS = 100;

export const filesRouter = router({
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
});
