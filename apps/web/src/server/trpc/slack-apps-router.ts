// Slack app procedures: a user downloads an agent's manifest, pastes the bot
// token and signing secret, and revokes the app. No procedure returns a secret.
import {
  slackAppListInputSchema,
  slackAppPasteInputSchema,
  slackAppRevokeInputSchema,
  slackManifestInputSchema,
} from "@repo/services/slack-apps";
import { router, workspaceProcedure } from "./init.ts";

export const slackAppsRouter = router({
  list: workspaceProcedure
    .input(slackAppListInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.slackApps.list(ctx.principal, input)
    ),
  manifest: workspaceProcedure
    .input(slackManifestInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.slackApps.manifest(ctx.principal, input)
    ),
  paste: workspaceProcedure
    .input(slackAppPasteInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.slackApps.paste(ctx.principal, input)
    ),
  revoke: workspaceProcedure
    .input(slackAppRevokeInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.slackApps.revoke(ctx.principal, input)
    ),
});
