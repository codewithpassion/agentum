import {
  mapConnectTriggerSchema,
  mapDisconnectTriggerSchema,
  mapGraphInputSchema,
  mapPositionsSchema,
  mapToolInputSchema,
} from "@repo/services/map";
import { router, workspaceProcedure } from "./init.ts";

export const mapRouter = router({
  connectTrigger: workspaceProcedure
    .input(mapConnectTriggerSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.map.connectTrigger(
        ctx.principal,
        input.triggerId,
        input.agentId
      )
    ),
  disconnectTrigger: workspaceProcedure
    .input(mapDisconnectTriggerSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.map.disconnectTrigger(ctx.principal, input.triggerId)
    ),
  graph: workspaceProcedure
    .input(mapGraphInputSchema)
    .query(({ ctx, input }) => ctx.services.map.graph(ctx.principal, input)),
  plugTool: workspaceProcedure
    .input(mapToolInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.map.plugTool(ctx.principal, input.agentId, input.tool)
    ),
  savePositions: workspaceProcedure
    .input(mapPositionsSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.map.savePositions(ctx.principal, input)
    ),
  unplugTool: workspaceProcedure
    .input(mapToolInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.map.unplugTool(ctx.principal, input.agentId, input.tool)
    ),
});
