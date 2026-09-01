import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { createDb } from "#/db/client";
import type { Agent } from "#/modules/agents/schema";
import { findAgentByMcpToken } from "#/modules/agents/service";
import type { Workspace } from "#/modules/workspaces/schema";
import { getWorkspaceById } from "#/modules/workspaces/service";
import { buildWorkspaceServer } from "./server";

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

export const mcpRoutes = new Hono<{
  Bindings: Env;
  Variables: { agent: Agent; workspace: Workspace };
}>();

mcpRoutes.all("/:agentToken", async (c) => {
  const db = createDb(c.env.DB);
  const agent = await findAgentByMcpToken(db, c.req.param("agentToken"));
  if (!agent) {
    return c.json({ error: "Unknown MCP token." }, UNAUTHORIZED);
  }

  // The token identifies the agent; the agent's row is what names the tenant
  // every tool call below is then scoped to.
  const workspace = await getWorkspaceById(db, agent.workspaceId);
  if (!workspace) {
    return c.json({ error: "Unknown MCP token." }, UNAUTHORIZED);
  }

  const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
  await buildWorkspaceServer({
    agent,
    db,
    env: c.env,
    requestUrl: c.req.url,
    workspace,
  }).connect(transport);
  return await transport.handleRequest(c);
});
