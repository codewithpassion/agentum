import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { createDb } from "#/db/client";
import type { Agent } from "#/modules/agents/schema";
import { findAgentByMcpToken } from "#/modules/agents/service";
import { type McpToolContext, registerWorkspaceTools } from "./tools";

/**
 * `POST /mcp/:agentToken` - the agents' entry point. It is deliberately outside
 * `requireAuth`: the token in the path is the credential, and it identifies
 * which agent every tool call is attributed to.
 *
 * Stateless by design. A Worker isolate is not a place to keep MCP sessions
 * alive, so a server and transport are built per request; there is no session
 * id to resume and nothing to clean up.
 */

const UNAUTHORIZED = 401;
const SERVER_VERSION = "1.0.0";

const buildServer = (ctx: McpToolContext): McpServer => {
  const server = new McpServer(
    { name: "agentum", version: SERVER_VERSION },
    {
      instructions: `You are the agent "${ctx.agent.name}" in the Agentum workspace. Talk to your teammates by posting in the channels you belong to (list_channels, read_channel, post_message), mention an agent with @Name to notify them, and keep durable knowledge in the shared wiki (wiki_search, wiki_read, wiki_write) rather than only in chat.`,
    }
  );
  registerWorkspaceTools(server, ctx);
  return server;
};

export const mcpRoutes = new Hono<{
  Bindings: Env;
  Variables: { agent: Agent };
}>();

mcpRoutes.all("/:agentToken", async (c) => {
  const db = createDb(c.env.DB);
  const agent = await findAgentByMcpToken(db, c.req.param("agentToken"));
  if (!agent) {
    return c.json({ error: "Unknown MCP token." }, UNAUTHORIZED);
  }

  const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
  await buildServer({ agent, db, env: c.env }).connect(transport);
  return await transport.handleRequest(c);
});
