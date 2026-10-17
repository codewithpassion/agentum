// Skill store procedures: the central, versioned skills (SK.1) for the Skills page and the agent Skills tab.
import {
  assignInputSchema,
  decideInputSchema,
  diffInputSchema,
  exportInputSchema,
  MESSAGE_MAX,
  pinInputSchema,
  revertInputSchema,
  skillRefSchema,
  versionRefSchema,
} from "@repo/services/skills-store/records";
import { z } from "zod";
import {
  base64ToBytes,
  bytesToBase64,
  decodeLibraryText,
} from "#/lib/library-content.ts";
import { router, workspaceProcedure } from "./init.ts";

const message = z.string().trim().min(1).max(MESSAGE_MAX);

// Files cross the wire as text or base64, since the result is plain JSON.
const fileWrite = z.discriminatedUnion("encoding", [
  z.strictObject({
    data: z.string(),
    encoding: z.literal("text"),
    executable: z.boolean().optional(),
    path: z.string(),
  }),
  z.strictObject({
    data: z.string(),
    encoding: z.literal("base64"),
    executable: z.boolean().optional(),
    path: z.string(),
  }),
]);

const toWrite = (file: z.infer<typeof fileWrite>) => ({
  content:
    file.encoding === "text"
      ? file.data
      : Uint8Array.from(base64ToBytes(file.data)),
  executable: file.executable,
  path: file.path,
});

export const skillStoreRouter = router({
  approve: workspaceProcedure
    .input(decideInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.skillsStore.approve(ctx.principal, input)
    ),
  assign: workspaceProcedure
    .input(assignInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.skillsStore.assign(ctx.principal, input)
    ),
  assignments: workspaceProcedure.query(({ ctx }) =>
    ctx.services.skillsStore.assignments(ctx.principal)
  ),
  commit: workspaceProcedure
    .input(
      z.strictObject({
        baseVersion: z.int().min(1),
        deletes: z.array(z.strictObject({ path: z.string() })).default([]),
        message,
        skillId: z.string().min(1),
        writes: z.array(fileWrite).default([]),
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.skillsStore.commit(ctx.principal, {
        ...input,
        writes: input.writes.map(toWrite),
      })
    ),
  create: workspaceProcedure
    .input(
      z.strictObject({
        files: z.array(fileWrite).min(1),
        message,
        name: z.string(),
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.skillsStore.create(ctx.principal, {
        ...input,
        files: input.files.map(toWrite),
      })
    ),
  diff: workspaceProcedure
    .input(diffInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.skillsStore.diff(ctx.principal, input)
    ),
  /** A version as a `.skill` file, base64 encoded. */
  exportArchive: workspaceProcedure
    .input(exportInputSchema)
    .query(async ({ ctx, input }) => {
      const { bytes, filename } =
        await ctx.services.skillsStore.exportSkillArchive(ctx.principal, input);
      return { data: bytesToBase64(bytes), filename };
    }),
  forAgent: workspaceProcedure
    .input(z.strictObject({ agentId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.skillsStore.forAgent(ctx.principal, input.agentId)
    ),
  /** A new skill or a new version from a `.skill` file, base64 encoded. */
  importArchive: workspaceProcedure
    .input(z.strictObject({ data: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.services.skillsStore.importSkillArchive(
        ctx.principal,
        base64ToBytes(input.data)
      )
    ),
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.services.skillsStore.list(ctx.principal)
  ),
  log: workspaceProcedure
    .input(skillRefSchema)
    .query(({ ctx, input }) =>
      ctx.services.skillsStore.log(ctx.principal, input)
    ),
  pin: workspaceProcedure
    .input(pinInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.skillsStore.pin(ctx.principal, input)
    ),
  proposals: workspaceProcedure.query(({ ctx }) =>
    ctx.services.skillsStore.proposals(ctx.principal)
  ),
  /** One file of a version. `text` is null for a file that is binary or too big for the editor. */
  readFile: workspaceProcedure
    .input(
      z.strictObject({
        path: z.string(),
        skillId: z.string().min(1),
        version: z.int().min(1),
      })
    )
    .query(async ({ ctx, input }) => {
      const shown = await ctx.services.skillsStore.show(ctx.principal, {
        skillId: input.skillId,
        version: input.version,
        withContents: true,
      });
      const file = shown.files.find((entry) => entry.path === input.path);
      if (!file) {
        return null;
      }
      return {
        executable: file.executable,
        size: file.size,
        text: decodeLibraryText(file.content ?? new Uint8Array()),
      };
    }),
  reject: workspaceProcedure
    .input(decideInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.skillsStore.reject(ctx.principal, input)
    ),
  revert: workspaceProcedure
    .input(revertInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.skillsStore.revert(ctx.principal, input)
    ),
  show: workspaceProcedure
    .input(versionRefSchema.omit({ withContents: true }))
    .query(({ ctx, input }) =>
      ctx.services.skillsStore.show(ctx.principal, input)
    ),
  unassign: workspaceProcedure
    .input(assignInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.skillsStore.unassign(ctx.principal, input)
    ),
});
