// Skills procedures: the skills an agent has, a new skill for it, and the files in each skill folder.
import { z } from "zod";
import {
  base64ToBytes,
  decodeLibraryText,
  textToBytes,
} from "#/lib/library-content.ts";
import { router, workspaceProcedure } from "./init.ts";

const agentInput = z.strictObject({ agentId: z.string().min(1) });
const skillInput = z.strictObject({
  agentId: z.string().min(1),
  scope: z.enum(["agent", "shared"]),
  skill: z.string().min(1),
});
const pathInput = z.string();
const ifEtag = z.string().optional();

export const skillsRouter = router({
  create: workspaceProcedure
    .input(
      z.strictObject({ agentId: z.string().min(1), name: z.string().min(1) })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.skills.create(ctx.principal, input.agentId, input.name)
    ),
  files: workspaceProcedure
    .input(skillInput)
    .query(({ ctx, input }) =>
      ctx.services.skills.tree(
        ctx.principal,
        input.agentId,
        input.scope,
        input.skill
      )
    ),
  list: workspaceProcedure
    .input(agentInput)
    .query(({ ctx, input }) =>
      ctx.services.skills.catalog(ctx.principal, input.agentId)
    ),
  readFile: workspaceProcedure
    .input(skillInput.extend({ path: pathInput }))
    .query(async ({ ctx, input }) => {
      const { bytes, entry } = await ctx.services.skills.readFile(
        ctx.principal,
        input.agentId,
        input.scope,
        input.skill,
        input.path
      );
      return { entry, text: decodeLibraryText(bytes) };
    }),
  removeFile: workspaceProcedure
    .input(skillInput.extend({ path: pathInput }))
    .mutation(({ ctx, input }) =>
      ctx.services.skills.removeFile(
        ctx.principal,
        input.agentId,
        input.scope,
        input.skill,
        input.path
      )
    ),
  writeFile: workspaceProcedure
    .input(
      z.discriminatedUnion("encoding", [
        skillInput.extend({
          data: z.string(),
          encoding: z.literal("text"),
          ifEtag,
          path: pathInput,
        }),
        skillInput.extend({
          data: z.string(),
          encoding: z.literal("base64"),
          ifEtag,
          path: pathInput,
        }),
      ])
    )
    .mutation(({ ctx, input }) => {
      const bytes =
        input.encoding === "text"
          ? textToBytes(input.data)
          : base64ToBytes(input.data);
      return ctx.services.skills.writeFile(
        ctx.principal,
        input.agentId,
        input.scope,
        input.skill,
        input.path,
        bytes,
        { ifEtag: input.ifEtag }
      );
    }),
});
