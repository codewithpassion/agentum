// Inbox procedures: threads and posts of the user's workspace.
import {
  clearAttentionInputSchema,
  postInputSchema,
  threadCreateInputSchema,
  threadListInputSchema,
  threadReadInputSchema,
} from "@repo/services/inbox";
import { router, workspaceProcedure } from "./init.ts";

export const inboxRouter = router({
  clearAttention: workspaceProcedure
    .input(clearAttentionInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.inbox.clearAttention(ctx.principal, input)
    ),
  createThread: workspaceProcedure
    .input(threadCreateInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.inbox.createThread(ctx.principal, input)
    ),
  listThreads: workspaceProcedure
    .input(threadListInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.inbox.listThreads(ctx.principal, input)
    ),
  post: workspaceProcedure
    .input(postInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.inbox.post(ctx.principal, input)
    ),
  readThread: workspaceProcedure
    .input(threadReadInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.inbox.readThread(ctx.principal, input)
    ),
  stopDiscussion: workspaceProcedure
    .input(threadReadInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.inbox.stopDiscussion(ctx.principal, input)
    ),
  topicTeam: workspaceProcedure
    .input(threadReadInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.inbox.topicTeam(ctx.principal, input)
    ),
});
