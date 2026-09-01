import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildWorkspaceServer } from "#/modules/mcp/server";
import type { McpToolContext } from "#/modules/mcp/tools";
import type { ToolDefinition } from "./chat";

/**
 * The workspace tools, reachable in-process. The same MCP server the managed
 * runtime calls over HTTP is connected to a client over an in-memory pipe, so
 * the Cloudflare runtime gets every tool with its schema and scoping exactly
 * as registered - and any tool added for one runtime exists for the other.
 */

export interface ToolResult {
  isError: boolean;
  text: string;
}

export interface ToolRunner {
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  close: () => Promise<void>;
  definitions: () => readonly ToolDefinition[];
}

/**
 * Per-conversation model overrides are an Anthropic-catalog feature: the
 * router ignores them for this runtime, so offering the tools would let the
 * agent promise a switch that never happens.
 */
const EXCLUDED_TOOLS = new Set(["set_model", "get_model"]);

const CLIENT_VERSION = "1.0.0";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const textOf = (content: unknown): string => {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block: { text?: unknown; type?: unknown }) =>
      block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : []
    )
    .join("\n");
};

export const connectWorkspaceTools = async (
  ctx: McpToolContext
): Promise<ToolRunner> => {
  const server = buildWorkspaceServer(ctx);
  const client = new Client({
    name: "agentum-runner",
    version: CLIENT_VERSION,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  const definitions: ToolDefinition[] = listed.tools
    .filter((tool) => !EXCLUDED_TOOLS.has(tool.name))
    .map((tool) => ({
      description: tool.description ?? "",
      name: tool.name,
      parameters: tool.inputSchema as Record<string, unknown>,
    }));
  const known = new Set(definitions.map((tool) => tool.name));

  return {
    async call(name, args) {
      if (!known.has(name)) {
        return { isError: true, text: `There is no tool named "${name}".` };
      }
      try {
        const result = await client.callTool({ arguments: args, name });
        return {
          isError: result.isError === true,
          text: textOf(result.content),
        };
      } catch (error) {
        // Invalid arguments surface as a protocol error rather than a tool
        // result; the model gets the validation message either way.
        return { isError: true, text: messageOf(error) };
      }
    },
    async close() {
      await client.close();
      await server.close();
    },
    definitions: () => definitions,
  };
};
