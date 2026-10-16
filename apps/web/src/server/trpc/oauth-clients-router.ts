// OAuth client procedures: a user approves, changes or revokes the apps that
// connect to the workspace's MCP endpoint through Clerk OAuth.
import {
  oauthClientRevokeInputSchema,
  oauthClientSetAccessInputSchema,
} from "@repo/services/oauth-clients";
import { router, workspaceProcedure } from "./init.ts";

export const oauthClientsRouter = router({
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.services.oauthClients.list(ctx.principal)
  ),
  revoke: workspaceProcedure
    .input(oauthClientRevokeInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.oauthClients.revoke(ctx.principal, input)
    ),
  setAccess: workspaceProcedure
    .input(oauthClientSetAccessInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.oauthClients.setAccess(ctx.principal, input)
    ),
});
