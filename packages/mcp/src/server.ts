import { McpServer } from "@modelcontextprotocol/server";
import packageJson from "../package.json";
import { registerTools } from "./register";
import { agentTools } from "./tools/agents";
import type { ToolDefinition } from "./tools/define";
import { inboxTools } from "./tools/inbox";
import { sessionTools } from "./tools/sessions";

export const HARBOURMASTER_TOOLS: readonly ToolDefinition[] = [
  ...agentTools,
  ...sessionTools,
  ...inboxTools,
];

export const TOOL_NAMES = HARBOURMASTER_TOOLS.map((tool) => tool.name);

/**
 * A fresh MCP server. This package knows nothing about Workers, Hono or
 * Clerk; the web app owns HTTP and authentication.
 */
export const createHarbourmasterMcpServer = (): McpServer => {
  // The tool list never changes after the server starts, so do not advertise
  // list changes: a client then never opens a `subscriptions/listen` stream
  // that could not receive an event anyway.
  const server = new McpServer(
    { name: "harbourmaster", version: packageJson.version },
    { capabilities: { tools: { listChanged: false } } }
  );
  registerTools(server, HARBOURMASTER_TOOLS);
  return server;
};
