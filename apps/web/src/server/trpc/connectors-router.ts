// Connector procedures: the registry, pasted header credentials, and which
// agents get which connector.
import {
  agentInputSchema,
  assignmentInputSchema,
  connectorCreateSchema,
  credentialSetSchema,
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
  setCredential: workspaceProcedure
    .input(credentialSetSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connectors.setCredential(ctx.principal, input)
    ),
  unassign: workspaceProcedure
    .input(unassignInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connectors.unassign(ctx.principal, input)
    ),
});
