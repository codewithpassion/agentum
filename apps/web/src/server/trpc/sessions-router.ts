import { SESSION_ORIGINS } from "@repo/services/runs/types";
import { SESSION_LIST_LIMIT } from "@repo/services/sessions";
import { z } from "zod";
import { router, workspaceProcedure } from "./init.ts";

const sessionInput = z.strictObject({ sessionId: z.string().min(1) });

export const sessionsRouter = router({
  archive: workspaceProcedure
    .input(sessionInput)
    .mutation(({ ctx, input }) =>
      ctx.services.sessions.archive(ctx.principal, input.sessionId)
    ),
  list: workspaceProcedure
    .input(
      z.strictObject({
        agentId: z.string().min(1).optional(),
        archived: z.boolean().optional(),
        cursor: z.string().min(1).max(300).optional(),
        limit: z.number().int().min(1).max(SESSION_LIST_LIMIT).optional(),
        origin: z.enum(SESSION_ORIGINS).optional(),
        query: z.string().max(200).optional(),
        working: z.boolean().optional(),
      })
    )
    .query(({ ctx, input }) =>
      ctx.services.sessions.list(ctx.principal, input)
    ),
  main: workspaceProcedure
    .input(z.strictObject({ agentId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.sessions.main(ctx.principal, input.agentId)
    ),
  pin: workspaceProcedure
    .input(sessionInput)
    .mutation(({ ctx, input }) =>
      ctx.services.sessions.pin(ctx.principal, input.sessionId)
    ),
  rename: workspaceProcedure
    .input(
      z.strictObject({
        sessionId: z.string().min(1),
        title: z.string().max(200),
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.services.sessions.rename(ctx.principal, input.sessionId, input.title)
    ),
  transcript: workspaceProcedure
    .input(sessionInput)
    .query(({ ctx, input }) =>
      ctx.services.sessions.transcript(ctx.principal, input.sessionId)
    ),
  unarchive: workspaceProcedure
    .input(sessionInput)
    .mutation(({ ctx, input }) =>
      ctx.services.sessions.unarchive(ctx.principal, input.sessionId)
    ),
  unpin: workspaceProcedure
    .input(sessionInput)
    .mutation(({ ctx, input }) =>
      ctx.services.sessions.unpin(ctx.principal, input.sessionId)
    ),
});
