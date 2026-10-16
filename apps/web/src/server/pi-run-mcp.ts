import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { CloudStart } from "@repo/services/cloud/types";

// The entry type is read off CloudStart because "@repo/services/connectors/mcp-servers" has no package export.
type McpServerEntry = CloudStart["mcpServers"][string];

/** A tool as an MCP server lists it in `tools/list`. */
export interface McpTool {
  annotations?: { readOnlyHint?: boolean };
  description?: string;
  inputSchema: Record<string, unknown>;
  name: string;
}

/** The fetch the client uses. Tests pass a fake; the default is the global `fetch`. */
export type McpFetch = (url: string, init: RequestInit) => Promise<Response>;

interface ContentPart {
  text?: string;
  type: string;
}

interface ToolCallResult {
  content: ContentPart[];
  isError?: boolean;
}

interface RpcReply {
  error?: { message: string };
  result?: unknown;
}

const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_ID = 1;
const TOOL_NAME_MAX = 64;
const SSE_DATA_PREFIX = "data:";
const SSE_DATA_PREFIX_LENGTH = SSE_DATA_PREFIX.length;

const INITIALIZE_PARAMS = {
  capabilities: {},
  clientInfo: { name: "harbourmaster-cloud-runtime", version: "0" },
  protocolVersion: PROTOCOL_VERSION,
};

// Calls the global through a lambda: a bare `fetch` loses its receiver in workerd.
const defaultFetch: McpFetch = (url, init) => fetch(url, init);

/** The last `data:` line of an SSE body, or the whole body when it has none. */
const replyText = (text: string): string => {
  const dataLines = text
    .split("\n")
    .filter((line) => line.startsWith(SSE_DATA_PREFIX));
  const last = dataLines.at(-1);
  return last === undefined ? text : last.slice(SSE_DATA_PREFIX_LENGTH).trim();
};

const rpc = async <T>(
  server: McpServerEntry,
  fetcher: McpFetch,
  method: string,
  params: unknown,
  signal?: AbortSignal
): Promise<T> => {
  const response = await fetcher(server.url, {
    body: JSON.stringify({ id: REQUEST_ID, jsonrpc: "2.0", method, params }),
    headers: {
      Accept: "application/json, text/event-stream",
      ...server.headers,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal,
  });
  if (!response.ok) {
    throw new Error(`MCP ${method} failed: ${response.status}`);
  }
  const reply: RpcReply = JSON.parse(replyText(await response.text()));
  if (reply.error) {
    throw new Error(reply.error.message);
  }
  // The server answers each method with the shape the MCP spec gives it, which the caller names with T.
  return reply.result as T;
};

/** initialize, then tools/list. The servers are stateless, so no session id is kept. */
export const listMcpTools = async (
  server: McpServerEntry,
  fetcher: McpFetch = defaultFetch
): Promise<McpTool[]> => {
  await rpc(server, fetcher, "initialize", INITIALIZE_PARAMS);
  const listed = await rpc<{ tools: McpTool[] }>(
    server,
    fetcher,
    "tools/list",
    {}
  );
  return listed.tools;
};

/** `${serverKey}_${tool}` with unsupported characters replaced, cut to the length Pi accepts. */
const piToolName = (serverKey: string, toolName: string): string =>
  `${serverKey}_${toolName}`
    .replaceAll(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, TOOL_NAME_MAX);

/** The name, or the name with a number that no tool of the server has taken, still within the length Pi accepts. */
const uniqueName = (name: string, taken: Set<string>): string => {
  let candidate = name;
  for (let attempt = 2; taken.has(candidate); attempt += 1) {
    const suffix = `_${attempt}`;
    candidate = `${name.slice(0, TOOL_NAME_MAX - suffix.length)}${suffix}`;
  }
  taken.add(candidate);
  return candidate;
};

const contentText = (content: readonly ContentPart[]): string =>
  content
    .map((part) =>
      part.type === "text" ? (part.text ?? "") : `[${part.type}]`
    )
    .join("\n");

/**
 * One Pi tool per MCP tool. `getServer` runs on every call, so a run token that
 * changes is picked up and never baked into the tool list.
 */
export const mcpToolRegistrations = (
  serverKey: string,
  tools: readonly McpTool[],
  getServer: () => Promise<McpServerEntry>,
  fetcher: McpFetch = defaultFetch
): ToolRegistration[] => {
  // Cutting a long name can make two tools of a server collide, and the registry refuses a repeat.
  const taken = new Set<string>();
  return tools.map(
    (tool): ToolRegistration => ({
      description: tool.description ?? tool.name,
      execute: async (args, _api, context) => {
        const server = await getServer();
        const result = await rpc<ToolCallResult>(
          server,
          fetcher,
          "tools/call",
          { arguments: args, name: tool.name },
          context.abortSignal
        );
        return {
          isError: result.isError === true,
          output: [{ text: contentText(result.content), type: "text" }],
        };
      },
      name: uniqueName(piToolName(serverKey, tool.name), taken),
      // Type.Unsafe passes the MCP JSON schema through unchanged.
      parameters: Type.Unsafe(tool.inputSchema),
      replay: tool.annotations?.readOnlyHint === true ? "safe" : "unsafe",
    })
  );
};
