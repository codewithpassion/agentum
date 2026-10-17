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

/** The outcome of listing one server, with its key. */
type Listing = { key: string; tools: McpTool[] } | Failure;
interface Failure {
  error: unknown;
  key: string;
}

/** The tools each server lists, keyed by the server's key. */
export type ServerTools = Record<string, McpTool[]>;

/**
 * Lists every server in parallel. A server that fails keeps the tools it had
 * (`known`), or is left out when it had none. The run fails only when nothing
 * is usable, so one unreachable connector does not stop the run from starting.
 */
export const syncMcpTools = async (
  servers: Record<string, McpServerEntry>,
  known: ServerTools,
  fetcher: McpFetch = defaultFetch,
  onDown: (key: string, error: unknown) => void = () => undefined
): Promise<ServerTools> => {
  // Each listing carries its key, so a failure can be matched to its server. The
  // handlers never throw, so Promise.all waits for every server, like allSettled.
  const listings: Listing[] = await Promise.all(
    Object.entries(servers).map(([key, server]) =>
      listMcpTools(server, fetcher).then(
        (tools): Listing => ({ key, tools }),
        (error: unknown): Listing => ({ error, key })
      )
    )
  );

  const usable: [string, McpTool[]][] = [];
  for (const listing of listings) {
    if ("tools" in listing) {
      usable.push([listing.key, listing.tools]);
      continue;
    }
    onDown(listing.key, listing.error);
    const kept = Object.hasOwn(known, listing.key)
      ? known[listing.key]
      : undefined;
    if (kept !== undefined) {
      usable.push([listing.key, kept]);
    }
  }

  // Only a run with no usable server fails, and it fails with the first failure, in the order of `servers`.
  const firstFailure = listings.find(
    (listing): listing is Failure => "error" in listing
  );
  if (firstFailure !== undefined && usable.length === 0) {
    throw firstFailure.error;
  }
  return Object.fromEntries(usable);
};

/**
 * The keys to install and to uninstall. Pi tells the model that the tools
 * changed on every install, so the caller re-installs only what changed.
 */
export const toolChanges = (
  installed: ServerTools,
  next: ServerTools
): { install: string[]; uninstall: string[] } => ({
  install: Object.keys(next).filter(
    (key) =>
      !Object.hasOwn(installed, key) ||
      JSON.stringify(installed[key]) !== JSON.stringify(next[key])
  ),
  uninstall: Object.keys(installed).filter((key) => !Object.hasOwn(next, key)),
});

/**
 * Wraps `work` so it runs at most once at a time, and not again until
 * `minGapMs` has passed since the last start. The returned function does not
 * wait for the work. A rejection is logged, not thrown, because the caller is
 * a tool call that must not fail on a background refresh.
 */
export const throttled = (
  work: () => Promise<void>,
  { minGapMs, now = Date.now }: { minGapMs: number; now?: () => number }
): (() => void) => {
  let running = false;
  let lastStarted: number | undefined;
  return () => {
    if (
      running ||
      (lastStarted !== undefined && now() - lastStarted < minGapMs)
    ) {
      return;
    }
    running = true;
    lastStarted = now();
    // The promise constructor runs `work` now and turns a synchronous throw into a rejection.
    new Promise<void>((resolve) => resolve(work()))
      .catch((error: unknown) => {
        console.error(
          "MCP refresh failed",
          error instanceof Error ? error.message : String(error)
        );
      })
      .finally(() => {
        running = false;
      });
  };
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
  fetcher: McpFetch = defaultFetch,
  onCallError?: () => void
): ToolRegistration[] => {
  // Cutting a long name can make two tools of a server collide, and the registry refuses a repeat.
  const taken = new Set<string>();
  return tools.map(
    (tool): ToolRegistration => ({
      description: tool.description ?? tool.name,
      execute: async (args, _api, context) => {
        const server = await getServer();
        let result: ToolCallResult;
        try {
          result = await rpc<ToolCallResult>(
            server,
            fetcher,
            "tools/call",
            { arguments: args, name: tool.name },
            context.abortSignal
          );
        } catch (error) {
          // A failed call is the only sign a POST-only client gets that the server's tools changed.
          if (context.abortSignal?.aborted !== true) {
            onCallError?.();
          }
          throw error;
        }
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
