import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getAgentSessionRow,
  listAgentSessionRows,
} from "#/modules/agents/session-history";
import type { AnthropicGateway } from "#/modules/anthropic/gateway";
import {
  backfillSessionHistory,
  createGateway,
} from "#/modules/anthropic/service";
import { fail, json } from "./format";
import type { McpToolContext } from "./tools";

/**
 * `list_past_sessions` and `read_past_session`: an agent's way back into its
 * own earlier sessions, after a new one started and the old context was lost.
 * Managed Agents only, and only the agent's own sessions - the history row is
 * looked up by agent id before Anthropic is asked anything.
 */

const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 50;
/** Entries per page; the gateway caps each one, which bounds a page near 40 KB. */
const PAGE_ENTRIES = 25;

type OpenGateway = (
  ctx: McpToolContext
) => Promise<Pick<AnthropicGateway, "listSessionEvents"> | null>;

const defaultOpenGateway: OpenGateway = (ctx) =>
  createGateway(ctx.db, ctx.env, ctx.workspace.id);

export const registerSessionTools = (
  server: McpServer,
  ctx: McpToolContext,
  openGateway: OpenGateway = defaultOpenGateway
): void => {
  server.registerTool(
    "list_past_sessions",
    {
      description:
        "List your own earlier sessions, newest first, with when each started and ended, why it ended, and which one is current. Use this to recall earlier work after a new session started and you no longer remember what was said or done. Then read one with read_past_session.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIST_LIMIT)
          .optional()
          .describe(
            `How many sessions to list. Default ${DEFAULT_LIST_LIMIT}.`
          ),
      },
      title: "List past sessions",
    },
    async ({ limit }) => {
      const take = limit ?? DEFAULT_LIST_LIMIT;
      let rows = await listAgentSessionRows(
        ctx.db,
        ctx.workspace.id,
        ctx.agent.id,
        take
      );
      if (rows.length === 0) {
        await backfillSessionHistory(ctx.db, ctx.env, ctx.agent);
        rows = await listAgentSessionRows(
          ctx.db,
          ctx.workspace.id,
          ctx.agent.id,
          take
        );
      }
      return json({
        sessions: rows.map((row) => ({
          current: row.endedAt === null,
          endedAt: row.endedAt?.toISOString() ?? null,
          endReason: row.endReason,
          sessionId: row.anthropicSessionId,
          startedAt: row.startedAt.toISOString(),
          title: row.title,
        })),
      });
    }
  );

  server.registerTool(
    "read_past_session",
    {
      description:
        "Read a page of one of your earlier sessions as a text transcript: what people asked, what you answered, and which tools you called. Use it to recall earlier work after a new session started. Get the session_id from list_past_sessions. When next_cursor is set, call again with it to read on.",
      inputSchema: {
        cursor: z
          .string()
          .optional()
          .describe("The next_cursor from the previous page."),
        session_id: z.string().describe("A sessionId from list_past_sessions."),
      },
      title: "Read a past session",
    },
    async ({ cursor, session_id }) => {
      const row = await getAgentSessionRow(
        ctx.db,
        ctx.workspace.id,
        ctx.agent.id,
        session_id
      );
      if (!row) {
        return fail(
          "No such session of yours. Use list_past_sessions to see your sessions."
        );
      }
      const gateway = await openGateway(ctx);
      if (!gateway) {
        return fail("Session history is not available right now.");
      }
      try {
        const page = await gateway.listSessionEvents(session_id, {
          cursor,
          limit: PAGE_ENTRIES,
        });
        return json({
          entries: page.entries,
          next_cursor: page.nextCursor,
          session_id,
        });
      } catch {
        return fail("That session could not be read.");
      }
    }
  );
};
