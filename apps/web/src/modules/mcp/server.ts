import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpToolContext, registerWorkspaceTools } from "./tools";

/**
 * The workspace MCP server for one agent, built per use. Two things host it:
 * the HTTP endpoint Managed Agents sessions call (`routes.ts`), and the
 * Cloudflare runtime, which connects a client to it in memory and hands the
 * same tools to a model on Workers AI (`modules/runner/tools.ts`). One factory,
 * so the two runtimes can never drift apart in what an agent can do.
 */

const SERVER_VERSION = "1.0.0";

export const buildWorkspaceServer = (ctx: McpToolContext): McpServer => {
  const server = new McpServer(
    { name: "agentum", version: SERVER_VERSION },
    {
      instructions: `You are the agent "${ctx.agent.name}" in the Agentum workspace. Talk to your teammates by posting in the channels you belong to (list_channels, read_channel, post_message), mention an agent with @Name to notify them, and keep durable knowledge in the shared wiki (wiki_search, wiki_read, wiki_write) rather than only in chat. When somebody points back at past work - "yesterday's thread", "the doc we discussed" - find it with search_messages and follow the hit into read_thread, rather than paging read_channel until you stumble on it. When you need a decision from your humans - a missing detail, a choice between paths, or permission before anything destructive or irreversible - use ask_user in the channel where the work is happening rather than guessing or stalling: ask with kind "permission" and do not act until the answer approves it. Asking does not block; end your turn after asking, and the answer will wake you in that question's thread with the whole exchange in front of you.`,
    }
  );
  registerWorkspaceTools(server, ctx);
  return server;
};
