// Library procedures: the files and folders of the user's workspace.
import { z } from "zod";
import {
  base64ToBytes,
  decodeLibraryText,
  textToBytes,
} from "#/lib/library-content.ts";
import { router, workspaceProcedure } from "./init.ts";

const pathInput = z.strictObject({ path: z.string() });
const ifEtag = z.string().optional();

export const libraryRouter = router({
  list: workspaceProcedure
    .input(z.strictObject({ dir: z.string().default("") }))
    .query(({ ctx, input }) =>
      ctx.services.library.list(ctx.principal, input.dir)
    ),
  mkdir: workspaceProcedure
    .input(pathInput)
    .mutation(({ ctx, input }) =>
      ctx.services.library.mkdir(ctx.principal, input.path)
    ),
  read: workspaceProcedure.input(pathInput).query(async ({ ctx, input }) => {
    const { bytes, entry } = await ctx.services.library.read(
      ctx.principal,
      input.path
    );
    return { entry, text: decodeLibraryText(bytes) };
  }),
  remove: workspaceProcedure
    .input(
      z.strictObject({
        path: z.string(),
        recursive: z.boolean().optional(),
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.library.remove(ctx.principal, input.path, {
        recursive: input.recursive,
      })
    ),
  write: workspaceProcedure
    .input(
      z.discriminatedUnion("encoding", [
        z.strictObject({
          data: z.string(),
          encoding: z.literal("text"),
          ifEtag,
          path: z.string(),
        }),
        z.strictObject({
          data: z.string(),
          encoding: z.literal("base64"),
          ifEtag,
          path: z.string(),
        }),
      ])
    )
    .mutation(({ ctx, input }) => {
      const bytes =
        input.encoding === "text"
          ? textToBytes(input.data)
          : base64ToBytes(input.data);
      return ctx.services.library.write(ctx.principal, input.path, bytes, {
        ifEtag: input.ifEtag,
      });
    }),
});
