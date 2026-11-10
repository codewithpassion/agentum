import {
  CONVERSATION_PAGE_LIMIT,
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
    .input(
      conversationInput.extend({
        before: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(CONVERSATION_PAGE_LIMIT).optional(),
      })
    )
    .query(({ ctx, input }) =>
      ctx.services.assistant.get(ctx.principal, input.conversationId, {
        before: input.before,
        limit: input.limit,
      })
    ),
  list: workspaceProcedure
    .input(
      z
        .strictObject({
          cursor: z.string().min(1).max(300).optional(),
          limit: z
            .number()
            .int()
            .min(1)
            .max(CONVERSATION_PAGE_LIMIT)
            .optional(),
          query: z.string().max(200).optional(),
        })
        .optional()
    )
    .query(({ ctx, input }) =>
      ctx.services.assistant.list(ctx.principal, input ?? {})
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
