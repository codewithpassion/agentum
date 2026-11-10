import { SESSION_ORIGINS } from "@repo/services/runs/types";
import { SESSION_LIST_LIMIT } from "@repo/services/sessions";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

export const conversationsRouter = router({
  list: workspaceProcedure
    .input(
      z.strictObject({
        agentId: z.string().min(1).optional(),
        cursor: z.string().min(1).max(300).optional(),
        limit: z.number().int().min(1).max(SESSION_LIST_LIMIT).optional(),
        origin: z.enum(SESSION_ORIGINS).optional(),
        query: z.string().max(200).optional(),
        working: z.boolean().optional(),
      })
    )
    .query(({ ctx, input }) =>
      ctx.services.conversations.list(ctx.principal, input)
    ),
});
