// A.2 fills this file.

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
import { TRPCError } from "@trpc/server";
import { router, workspaceProcedure } from "./init.ts";

const CALL_ERROR_CODES = {
  failed: "BAD_GATEWAY",
  needs_auth: "PRECONDITION_FAILED",
  not_granted: "FORBIDDEN",
  too_large: "PAYLOAD_TOO_LARGE",
} as const;

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
    .query(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.get is not implemented yet",
      });
    }),
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
    .query(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.list is not implemented yet",
      });
    }),
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
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.remove is not implemented yet",
      });
    }),
  rename: workspaceProcedure
    .input(artifactsRenameInputSchema)
    .output(artifactsRenameOutputSchema)
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.rename is not implemented yet",
      });
    }),
  restore: workspaceProcedure
    .input(artifactsRestoreInputSchema)
    .output(artifactsRestoreOutputSchema)
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.restore is not implemented yet",
      });
    }),
  setAudience: workspaceProcedure
    .input(artifactsSetAudienceInputSchema)
    .output(artifactsSetAudienceOutputSchema)
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.setAudience is not implemented yet",
      });
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
    .query(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.versions is not implemented yet",
      });
    }),
});
