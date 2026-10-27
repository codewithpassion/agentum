// Core procedures over the artifacts service (A.2). The shares half is in
// artifact-shares-router.ts, the phase 2 procedures throw until their tasks.

import {
  artifactsCallToolInputSchema,
  artifactsCallToolOutputSchema,
  artifactsDecideGrantInputSchema,
  artifactsDecideGrantOutputSchema,
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
import type { ArtifactsService } from "@repo/services/artifacts/service";
import { TRPCError } from "@trpc/server";
import type { Services } from "../compose.ts";
import { router, workspaceProcedure } from "./init.ts";

const CALL_ERROR_CODES = {
  failed: "BAD_GATEWAY",
  needs_auth: "PRECONDITION_FAILED",
  not_granted: "FORBIDDEN",
  too_large: "PAYLOAD_TOO_LARGE",
} as const;
// A.6 adds `artifacts` to `Services`; until then the service may be missing.
// A.6 replaces this accessor with `ctx.services.artifacts`.
const artifactsOf = (ctx: { services: Services }): ArtifactsService => {
  const service = (ctx.services as Partial<{ artifacts: ArtifactsService }>)
    .artifacts;
  if (!service) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Artifacts service is not wired",
    });
  }
  return service;
};

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
  decideGrant: workspaceProcedure
    .input(artifactsDecideGrantInputSchema)
    .output(artifactsDecideGrantOutputSchema)
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.decideGrant is not implemented yet",
      });
    }),
  get: workspaceProcedure
    .input(artifactsGetInputSchema)
    .output(artifactsGetOutputSchema)
    .query(({ ctx, input }) =>
      artifactsOf(ctx).get(ctx.principal, input.artifactId)
    ),
  handTo: workspaceProcedure
    .input(artifactsHandToInputSchema)
    .output(artifactsHandToOutputSchema)
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.handTo is not implemented yet",
      });
    }),
  list: workspaceProcedure
    .input(artifactsListInputSchema)
    .output(artifactsListOutputSchema)
    .query(({ ctx, input }) => artifactsOf(ctx).list(ctx.principal, input)),
  pin: workspaceProcedure
    .input(artifactsPinInputSchema)
    .output(artifactsPinOutputSchema)
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.pin is not implemented yet",
      });
    }),
  promote: workspaceProcedure
    .input(artifactsPromoteInputSchema)
    .output(artifactsPromoteOutputSchema)
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.promote is not implemented yet",
      });
    }),
  remove: workspaceProcedure
    .input(artifactsRemoveInputSchema)
    .output(artifactsRemoveOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await artifactsOf(ctx).remove(ctx.principal, input.artifactId);
      return {};
    }),
  rename: workspaceProcedure
    .input(artifactsRenameInputSchema)
    .output(artifactsRenameOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await artifactsOf(ctx).rename(
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
      artifactsOf(ctx).restore(ctx.principal, input.artifactId, input.version)
    ),
  setAudience: workspaceProcedure
    .input(artifactsSetAudienceInputSchema)
    .output(artifactsSetAudienceOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await artifactsOf(ctx).setAudience(
        ctx.principal,
        input.artifactId,
        input.audience
      );
      return {};
    }),
  unpin: workspaceProcedure
    .input(artifactsUnpinInputSchema)
    .output(artifactsUnpinOutputSchema)
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.unpin is not implemented yet",
      });
    }),
  versions: workspaceProcedure
    .input(artifactsVersionsInputSchema)
    .output(artifactsVersionsOutputSchema)
    .query(({ ctx, input }) =>
      artifactsOf(ctx).versions(ctx.principal, input.artifactId)
    ),
});
