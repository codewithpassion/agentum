// Inbox procedures: threads and posts of the user's workspace.
import {
  postInputSchema,
  threadCreateInputSchema,
  threadReadInputSchema,
} from "@repo/services/inbox";
import { router, workspaceProcedure } from "./init.ts";

export const inboxRouter = router({
  createThread: workspaceProcedure
    .input(threadCreateInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.inbox.createThread(ctx.principal, input)
    ),
  listThreads: workspaceProcedure.query(({ ctx }) =>
    ctx.services.inbox.listThreads(ctx.principal)
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
});
