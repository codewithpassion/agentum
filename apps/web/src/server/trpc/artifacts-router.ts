// Core procedures over the artifacts service (A.2). The shares half is in
// artifact-shares-router.ts, the phase 2 procedures throw until their tasks.

import { ARTIFACT_PIN_SURFACES } from "@repo/db/shared";
import {
  ARTIFACT_SOURCE_MAX_BYTES,
  artifactsCallToolInputSchema,
  artifactsCallToolOutputSchema,
  artifactsDecideGrantInputSchema,
  artifactsDecideGrantOutputSchema,
  artifactsFilesInputSchema,
  artifactsFilesOutputSchema,
  artifactsGetInputSchema,
  artifactsGetOutputSchema,
  artifactsHandToInputSchema,
  artifactsHandToOutputSchema,
  artifactsListInputSchema,
  artifactsListOutputSchema,
  artifactsPinInputSchema,
  artifactsPinOutputSchema,
  artifactsPromoteInputSchema,
  artifactsPromoteOutputSchema,
  artifactsReadFileInputSchema,
  artifactsReadFileOutputSchema,
  artifactsRemoveInputSchema,
  artifactsRemoveOutputSchema,
  artifactsRenameInputSchema,
  artifactsRenameOutputSchema,
  artifactsRestoreInputSchema,
  artifactsRestoreOutputSchema,
  artifactsSetAudienceInputSchema,
  artifactsSetAudienceOutputSchema,
  artifactsUnpinInputSchema,
  artifactsUnpinOutputSchema,
  artifactsVersionsInputSchema,
  artifactsVersionsOutputSchema,
} from "@repo/protocol/artifacts";
import { isArtifactCallError } from "@repo/services/artifacts/calls";
import { ServiceError } from "@repo/services/errors";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const CALL_ERROR_CODES = {
  failed: "BAD_GATEWAY",
  needs_auth: "PRECONDITION_FAILED",
  not_granted: "FORBIDDEN",
  too_large: "PAYLOAD_TOO_LARGE",
} as const;
const endpointSchema = z.strictObject({
  disabledAt: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  url: z.string(),
});
export const artifactsRouter = router({
  callTool: workspaceProcedure
    .input(artifactsCallToolInputSchema)
    .output(artifactsCallToolOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.artifactCalls.callTool(ctx.principal, input);
      } catch (error) {
        throw isArtifactCallError(error)
          ? new TRPCError({
              cause: error,
              code: CALL_ERROR_CODES[error.code],
              message: error.message,
            })
          : error;
      }
    }),
  changeEndpoint: workspaceProcedure
    .input(
      z.object({
        action: z.enum(["disable", "enable", "rotate"]),
        id: z.string().min(1),
      })
    )
    .output(endpointSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.artifactEndpoints.change(
        ctx.principal,
        input.id,
        input.action
      )
    ),
  decideGrant: workspaceProcedure
    .input(artifactsDecideGrantInputSchema)
    .output(artifactsDecideGrantOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.services.artifactGrants.decideGrant(ctx.principal, input);
      return {};
    }),
  endpoints: workspaceProcedure
    .input(z.object({ artifactId: z.string().min(1) }))
    .output(z.array(endpointSchema))
    .query(({ ctx, input }) =>
      ctx.services.artifactEndpoints.list(ctx.principal, input.artifactId)
    ),
  files: workspaceProcedure
    .input(artifactsFilesInputSchema)
    .output(artifactsFilesOutputSchema)
    .query(({ ctx, input }) =>
      ctx.services.artifacts.files(ctx.principal, input)
    ),
  get: workspaceProcedure
    .input(artifactsGetInputSchema)
    .output(artifactsGetOutputSchema)
    .query(({ ctx, input }) =>
      ctx.services.artifacts.get(ctx.principal, input.artifactId)
    ),
  /** The grants of one version, for the share dialog and the viewer (B.9). */
  grants: workspaceProcedure
    .input(
      z.strictObject({ artifactId: z.uuid(), versionId: z.string().min(1) })
    )
    .query(({ ctx, input }) =>
      ctx.services.artifactGrants.list(ctx.principal, input)
    ),
  handTo: workspaceProcedure
    .input(artifactsHandToInputSchema)
    .output(artifactsHandToOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.services.artifactGrants.handTo(ctx.principal, input);
      return {};
    }),
  list: workspaceProcedure
    .input(artifactsListInputSchema)
    .output(artifactsListOutputSchema)
    .query(({ ctx, input }) =>
      ctx.services.artifacts.list(ctx.principal, input)
    ),
  pin: workspaceProcedure
    .input(artifactsPinInputSchema)
    .output(artifactsPinOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.services.artifactPins.pin(ctx.principal, input);
      return {};
    }),
  /** The caller's pins, for the sidebar, the desk and the viewer menu (B.9). */
  pins: workspaceProcedure
    .input(
      z.strictObject({ surface: z.enum(ARTIFACT_PIN_SURFACES).optional() })
    )
    .query(({ ctx, input }) =>
      ctx.services.artifactPins.list(
        ctx.principal,
        input.surface === undefined ? {} : { surface: input.surface }
      )
    ),
  promote: workspaceProcedure
    .input(artifactsPromoteInputSchema)
    .output(artifactsPromoteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.services.artifactGrants.promote(
        ctx.principal,
        input
      );
      if (result.status !== "promoted") {
        throw new ServiceError("conflict", "The grants need a decision first");
      }
      return { version: result.version };
    }),
  readFile: workspaceProcedure
    .input(artifactsReadFileInputSchema)
    .output(artifactsReadFileOutputSchema)
    .query(async ({ ctx, input }) => {
      const read = await ctx.services.artifacts.readFile(ctx.principal, input);
      const bytes = new TextEncoder().encode(read.text);
      const truncated = bytes.length > ARTIFACT_SOURCE_MAX_BYTES;
      return {
        ...read,
        text: truncated
          ? new TextDecoder().decode(
              bytes.subarray(0, ARTIFACT_SOURCE_MAX_BYTES),
              { stream: true }
            )
          : read.text,
        truncated,
      };
    }),
  remove: workspaceProcedure
    .input(artifactsRemoveInputSchema)
    .output(artifactsRemoveOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.services.artifacts.remove(ctx.principal, input.artifactId);
      return {};
    }),
  rename: workspaceProcedure
    .input(artifactsRenameInputSchema)
    .output(artifactsRenameOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.services.artifacts.rename(
        ctx.principal,
        input.artifactId,
        input.title
      );
      return {};
    }),
  restore: workspaceProcedure
    .input(artifactsRestoreInputSchema)
    .output(artifactsRestoreOutputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.artifacts.restore(
        ctx.principal,
        input.artifactId,
        input.version
      )
    ),
  setAudience: workspaceProcedure
    .input(artifactsSetAudienceInputSchema)
    .output(artifactsSetAudienceOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.services.artifacts.setAudience(
        ctx.principal,
        input.artifactId,
        input.audience
      );
      return {};
    }),
  unpin: workspaceProcedure
    .input(artifactsUnpinInputSchema)
    .output(artifactsUnpinOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.services.artifactPins.unpin(ctx.principal, input);
      return {};
    }),
  versions: workspaceProcedure
    .input(artifactsVersionsInputSchema)
    .output(artifactsVersionsOutputSchema)
    .query(({ ctx, input }) =>
      ctx.services.artifacts.versions(ctx.principal, input.artifactId)
    ),
});
