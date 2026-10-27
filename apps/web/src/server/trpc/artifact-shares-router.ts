// Opens, link shares and the access log of artifacts (A.3). Thin over
// `@repo/services/artifacts/shares`.

import {
  artifactsCreateShareInputSchema,
  artifactsCreateShareOutputSchema,
  artifactsLinksEnabledOutputSchema,
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
import { router, workspaceProcedure } from "./init.ts";

export const artifactSharesRouter = router({
  createShare: workspaceProcedure
    .input(artifactsCreateShareInputSchema)
    .output(artifactsCreateShareOutputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.artifactShares.createShare(ctx.principal, input)
    ),
  linksEnabled: workspaceProcedure
    .output(artifactsLinksEnabledOutputSchema)
    .query(async ({ ctx }) => ({
      enabled: await ctx.services.artifactShares.linksEnabled(ctx.principal),
    })),
  open: workspaceProcedure
    .input(artifactsOpenInputSchema)
    .output(artifactsOpenOutputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.artifactShares.open(ctx.principal, input)
    ),
  revokeShare: workspaceProcedure
    .input(artifactsRevokeShareInputSchema)
    .output(artifactsRevokeShareOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.services.artifactShares.revokeShare(ctx.principal, input);
      return {};
    }),
  setLinksEnabled: workspaceProcedure
    .input(artifactsSetLinksEnabledInputSchema)
    .output(artifactsSetLinksEnabledOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.services.artifactShares.setLinksEnabled(ctx.principal, input);
      return {};
    }),
  shares: workspaceProcedure
    .input(artifactsSharesInputSchema)
    .output(artifactsSharesOutputSchema)
    .query(({ ctx, input }) =>
      ctx.services.artifactShares.shares(ctx.principal, input)
    ),
  views: workspaceProcedure
    .input(artifactsViewsInputSchema)
    .output(artifactsViewsOutputSchema)
    .query(({ ctx, input }) =>
      ctx.services.artifactShares.views(ctx.principal, input)
    ),
});
