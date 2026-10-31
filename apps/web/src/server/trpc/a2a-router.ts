import {
  accessKeyInputSchema,
  addOutboundInputSchema,
  agentIdInputSchema,
  approveSeenSchema,
  joinWithLinkInputSchema,
  listInputSchema,
  policiesInputSchema,
  previewCardInputSchema,
  publishInputSchema,
} from "@repo/services/a2a/connections";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const connectionInput = z.strictObject({
  connectionId: z.string().min(1).max(200),
});
const taskInput = z.strictObject({ taskId: z.string().min(1).max(200) });
const approveInput = connectionInput.extend({ seen: approveSeenSchema });

/** The agent connections page: one service call per procedure, the services decide who may. */
export const a2aRouter = router({
  addOutbound: workspaceProcedure
    .input(addOutboundInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connections.addOutbound(ctx.principal, input)
    ),
  approve: workspaceProcedure
    .input(approveInput)
    .mutation(({ ctx, input }) =>
      ctx.services.connections.approve(
        ctx.principal,
        input.connectionId,
        input.seen
      )
    ),
  approveMessage: workspaceProcedure
    .input(taskInput)
    .mutation(({ ctx, input }) =>
      ctx.services.a2aTasks.approveTask(ctx.principal, input.taskId)
    ),
  createAccessKey: workspaceProcedure
    .input(accessKeyInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connections.createAccessKey(ctx.principal, input)
    ),
  createInvite: workspaceProcedure
    .input(agentIdInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connections.createInvite(ctx.principal, input)
    ),
  decline: workspaceProcedure
    .input(connectionInput)
    .mutation(({ ctx, input }) =>
      ctx.services.connections.decline(ctx.principal, input.connectionId)
    ),
  declineMessage: workspaceProcedure
    .input(taskInput)
    .mutation(({ ctx, input }) =>
      ctx.services.a2aTasks.declineTask(ctx.principal, input.taskId)
    ),
  get: workspaceProcedure
    .input(connectionInput)
    .query(({ ctx, input }) =>
      ctx.services.connections.get(ctx.principal, input.connectionId)
    ),
  joinWithLink: workspaceProcedure
    .input(joinWithLinkInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connections.joinWithLink(ctx.principal, input)
    ),
  list: workspaceProcedure
    .input(listInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.connections.list(ctx.principal, input)
    ),
  manage: workspaceProcedure
    .input(connectionInput)
    .query(({ ctx, input }) =>
      ctx.services.a2aPageReads.manage(ctx.principal, input.connectionId)
    ),
  previewCard: workspaceProcedure
    .input(previewCardInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connections.previewCard(ctx.principal, input)
    ),
  publish: workspaceProcedure
    .input(publishInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connections.publish(ctx.principal, input)
    ),
  published: workspaceProcedure
    .input(agentIdInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.connections.getPublished(ctx.principal, input.agentId)
    ),
  recentTasks: workspaceProcedure
    .input(connectionInput)
    .query(({ ctx, input }) =>
      ctx.services.a2aPageReads.recentTasks(ctx.principal, input.connectionId)
    ),
  revoke: workspaceProcedure
    .input(connectionInput)
    .mutation(({ ctx, input }) =>
      ctx.services.connections.revoke(ctx.principal, input.connectionId)
    ),
  setPolicies: workspaceProcedure
    .input(policiesInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connections.setPolicies(ctx.principal, input)
    ),
  unpublish: workspaceProcedure
    .input(agentIdInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.connections.unpublish(ctx.principal, input.agentId)
    ),
});
