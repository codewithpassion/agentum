// A.3 fills this file.

import {
  artifactsCreateShareInputSchema,
  artifactsCreateShareOutputSchema,
  artifactsOpenInputSchema,
  artifactsOpenOutputSchema,
  artifactsRevokeShareInputSchema,
  artifactsRevokeShareOutputSchema,
  artifactsSetLinksEnabledInputSchema,
  artifactsSetLinksEnabledOutputSchema,
  artifactsSharesInputSchema,
  artifactsSharesOutputSchema,
  artifactsViewsInputSchema,
  artifactsViewsOutputSchema,
} from "@repo/protocol/artifacts";
import { TRPCError } from "@trpc/server";
import { router, workspaceProcedure } from "./init.ts";

export const artifactSharesRouter = router({
  createShare: workspaceProcedure
    .input(artifactsCreateShareInputSchema)
    .output(artifactsCreateShareOutputSchema)
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.createShare is not implemented yet",
      });
    }),
  open: workspaceProcedure
    .input(artifactsOpenInputSchema)
    .output(artifactsOpenOutputSchema)
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.open is not implemented yet",
      });
    }),
  revokeShare: workspaceProcedure
    .input(artifactsRevokeShareInputSchema)
    .output(artifactsRevokeShareOutputSchema)
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.revokeShare is not implemented yet",
      });
    }),
  setLinksEnabled: workspaceProcedure
    .input(artifactsSetLinksEnabledInputSchema)
    .output(artifactsSetLinksEnabledOutputSchema)
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.setLinksEnabled is not implemented yet",
      });
    }),
  shares: workspaceProcedure
    .input(artifactsSharesInputSchema)
    .output(artifactsSharesOutputSchema)
    .query(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.shares is not implemented yet",
      });
    }),
  views: workspaceProcedure
    .input(artifactsViewsInputSchema)
    .output(artifactsViewsOutputSchema)
    .query(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "artifacts.views is not implemented yet",
      });
    }),
});
