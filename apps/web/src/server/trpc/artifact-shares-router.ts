// Opens, link shares and the access log of artifacts (A.3). Thin over
// `@repo/services/artifacts/shares`. A.6 adds the service to `Services` in
// compose.ts; until then the procedures answer NOT_IMPLEMENTED.

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
import type { ArtifactSharesService } from "@repo/services/artifacts/shares";
import { TRPCError } from "@trpc/server";
import type { Services } from "../compose.ts";
import type { Context } from "./context.ts";
import { router, workspaceProcedure } from "./init.ts";

const sharesService = (ctx: Context): ArtifactSharesService => {
  const { artifactShares } = ctx.services as Services & {
    artifactShares?: ArtifactSharesService;
  };
  if (!artifactShares) {
    throw new TRPCError({
      code: "NOT_IMPLEMENTED",
      message: "The artifact shares service is not wired yet",
    });
  }
  return artifactShares;
};

export const artifactSharesRouter = router({
  createShare: workspaceProcedure
    .input(artifactsCreateShareInputSchema)
    .output(artifactsCreateShareOutputSchema)
    .mutation(({ ctx, input }) =>
      sharesService(ctx).createShare(ctx.principal, input)
    ),
  open: workspaceProcedure
    .input(artifactsOpenInputSchema)
    .output(artifactsOpenOutputSchema)
    .mutation(({ ctx, input }) =>
      sharesService(ctx).open(ctx.principal, input)
    ),
  revokeShare: workspaceProcedure
    .input(artifactsRevokeShareInputSchema)
    .output(artifactsRevokeShareOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await sharesService(ctx).revokeShare(ctx.principal, input);
      return {};
    }),
  setLinksEnabled: workspaceProcedure
    .input(artifactsSetLinksEnabledInputSchema)
    .output(artifactsSetLinksEnabledOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await sharesService(ctx).setLinksEnabled(ctx.principal, input);
      return {};
    }),
  shares: workspaceProcedure
    .input(artifactsSharesInputSchema)
    .output(artifactsSharesOutputSchema)
    .query(({ ctx, input }) => sharesService(ctx).shares(ctx.principal, input)),
  views: workspaceProcedure
    .input(artifactsViewsInputSchema)
    .output(artifactsViewsOutputSchema)
    .query(({ ctx, input }) => sharesService(ctx).views(ctx.principal, input)),
});
