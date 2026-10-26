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
  access: router({
    list: workspaceProcedure
      .input(z.strictObject({ agentId: z.string().min(1) }))
      .query(({ ctx, input }) =>
        ctx.services.libraryAccess.listGrants(ctx.principal, input.agentId)
      ),
    remove: workspaceProcedure
      .input(z.strictObject({ agentId: z.string().min(1), path: z.string() }))
      .mutation(({ ctx, input }) =>
        ctx.services.libraryAccess.removeGrant(
          ctx.principal,
          input.agentId,
          input.path
        )
      ),
    set: workspaceProcedure
      .input(
        z.strictObject({
          agentId: z.string().min(1),
          mode: z.enum(["read", "write"]),
          path: z.string(),
        })
      )
      .mutation(({ ctx, input }) =>
        ctx.services.libraryAccess.setGrant(
          ctx.principal,
          input.agentId,
          input.path,
          input.mode
        )
      ),
  }),
  compare: workspaceProcedure
    .input(z.strictObject({ a: z.string(), b: z.string() }))
    .query(({ ctx, input }) =>
      ctx.services.library.compare(ctx.principal, input.a, input.b)
    ),
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
  move: workspaceProcedure
    .input(z.strictObject({ from: z.string(), to: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.services.library.move(ctx.principal, input.from, input.to)
    ),
  read: workspaceProcedure.input(pathInput).query(async ({ ctx, input }) => {
    const { bytes, entry } = await ctx.services.library.read(
      ctx.principal,
      input.path
    );
    return { entry, text: decodeLibraryText(bytes) };
  }),
  readVersion: workspaceProcedure
    .input(z.strictObject({ versionId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { bytes, version } = await ctx.services.library.readVersion(
        ctx.principal,
        input.versionId
      );
      return { text: decodeLibraryText(bytes), version };
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
  restore: workspaceProcedure
    .input(z.strictObject({ ifEtag, versionId: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.services.library.restore(ctx.principal, input.versionId, {
        ifEtag: input.ifEtag,
      })
    ),
  stat: workspaceProcedure
    .input(pathInput)
    .query(({ ctx, input }) =>
      ctx.services.library.stat(ctx.principal, input.path)
    ),
  versions: workspaceProcedure
    .input(pathInput)
    .query(({ ctx, input }) =>
      ctx.services.library.versions(ctx.principal, input.path)
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
