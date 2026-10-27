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
import { ServiceError } from "@repo/services/errors";
import { TRPCError } from "@trpc/server";
import { router, workspaceProcedure } from "./init.ts";

export const artifactsRouter = router({
  callTool: workspaceProcedure
    .input(artifactsCallToolInputSchema)
    .output(artifactsCallToolOutputSchema)
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.callTool is not implemented yet",
      });
    }),
  decideGrant: workspaceProcedure
    .input(artifactsDecideGrantInputSchema)
    .output(artifactsDecideGrantOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.services.artifactGrants.decideGrant(ctx.principal, input);
      return {};
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
    .mutation(async ({ ctx, input }) => {
      await ctx.services.artifactGrants.handTo(ctx.principal, input);
      return {};
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
    .mutation(async ({ ctx, input }) => {
      await ctx.services.artifactPins.pin(ctx.principal, input);
      return {};
    }),
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
    .mutation(async ({ ctx, input }) => {
      await ctx.services.artifactPins.unpin(ctx.principal, input);
      return {};
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
