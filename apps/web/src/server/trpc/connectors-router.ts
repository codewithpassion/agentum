// Connector procedures: the registry, the auth mode, the per-call time limit, pasted header
// credentials, the OAuth client for a server that needs one typed in, and which
// agents get which connector. Connecting itself is a redirect flow, in
// routes/connectors-oauth.ts.
import { oauthClientSchema } from "@repo/services/connector-oauth";
import {
  agentInputSchema,
  assignmentInputSchema,
  connectorAuthModeSchema,
  connectorCallTimeoutSchema,
  connectorCreateSchema,
  credentialSetSchema,
  removeInputSchema,
  unassignInputSchema,
} from "@repo/services/connectors";
import { router, workspaceProcedure } from "./init.ts";

export const connectorsRouter = router({
  assign: workspaceProcedure
    .input(assignmentInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connectors.assign(ctx.principal, input)
    ),
  assignments: workspaceProcedure
    .input(agentInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.connectors.assignments(ctx.principal, input)
    ),
  create: workspaceProcedure
    .input(connectorCreateSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connectors.create(ctx.principal, input)
    ),
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.services.connectors.list(ctx.principal)
  ),
  remove: workspaceProcedure
    .input(removeInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connectors.remove(ctx.principal, input)
    ),
  setAuthMode: workspaceProcedure
    .input(connectorAuthModeSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connectors.setAuthMode(ctx.principal, input)
    ),
  setCallTimeout: workspaceProcedure
    .input(connectorCallTimeoutSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connectors.setCallTimeout(ctx.principal, input)
    ),
  setCredential: workspaceProcedure
    .input(credentialSetSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connectors.setCredential(ctx.principal, input)
    ),
  setOAuthClient: workspaceProcedure
    .input(oauthClientSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connectorOAuth.setClient(ctx.principal, input)
    ),
  unassign: workspaceProcedure
    .input(unassignInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connectors.unassign(ctx.principal, input)
    ),
});
