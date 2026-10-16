import { McpServer } from "@modelcontextprotocol/server";
import packageJson from "../package.json";
import type { McpPorts } from "./ports";
import { registerTools } from "./register";
import { agentTools } from "./tools/agents";
import type { ToolDefinition } from "./tools/define";
import { inboxTools } from "./tools/inbox";
import { sessionTools } from "./tools/sessions";

/** Every tool this server offers, bound to the ports it calls. */
export const harbourmasterTools = (
  ports: McpPorts
): readonly ToolDefinition[] => [
  ...agentTools(ports),
  ...sessionTools(ports),
  ...inboxTools,
];

/** Ports for reading tool names: the names do not depend on them, so none is ever called. */
const unusedPort = (): Promise<never> =>
  Promise.reject(new Error("Only the tool names are read."));

/** The name of every tool, in the order they are registered. */
export const TOOL_NAMES = harbourmasterTools({
  getRun: unusedPort,
  listAgents: unusedPort,
  listSessions: unusedPort,
  readSession: unusedPort,
  searchSessions: unusedPort,
  sendMessage: unusedPort,
}).map((tool) => tool.name);

/**
 * A fresh MCP server. This package knows nothing about Workers, Hono or
 * Clerk; the web app owns HTTP and authentication, and passes the ports the
 * tools call.
 */
export const createHarbourmasterMcpServer = (ports: McpPorts): McpServer => {
  // The tool list never changes after the server starts, so do not advertise
  // list changes: a client then never opens a `subscriptions/listen` stream
  // that could not receive an event anyway.
  const server = new McpServer(
    { name: "harbourmaster", version: packageJson.version },
    { capabilities: { tools: { listChanged: false } } }
  );
  registerTools(server, harbourmasterTools(ports));
  return server;
};
