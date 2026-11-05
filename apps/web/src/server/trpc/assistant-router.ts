import {
  resolveCardInputSchema,
  sendInputSchema,
} from "@repo/services/assistant/service";
import { z } from "zod";
import { router, workspaceProcedure } from "./init";

const conversationInput = z.strictObject({
  conversationId: z.string().min(1).max(200),
});
export const assistantRouter = router({
  archive: workspaceProcedure
    .input(conversationInput)
    .mutation(({ ctx, input }) =>
      ctx.services.assistant.archive(ctx.principal, input.conversationId)
    ),
  get: workspaceProcedure
    .input(conversationInput)
    .query(({ ctx, input }) =>
      ctx.services.assistant.get(ctx.principal, input.conversationId)
    ),
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.services.assistant.list(ctx.principal)
  ),
  resolveCard: workspaceProcedure
    .input(resolveCardInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.assistant.resolveCard(ctx.principal, input)
    ),
  send: workspaceProcedure
    .input(sendInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.assistant.send(ctx.principal, input)
    ),
});
