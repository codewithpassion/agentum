import type { CachedTool } from "./schema";
import { assertSafeUrl } from "./url";

/**
 * A minimal Streamable HTTP MCP client: `initialize`, then `tools/list`.
 *
 * Hand-rolled rather than `@modelcontextprotocol/sdk`'s transport because the
 * ladder in `oauth.ts` is driven by the raw 401 and its `WWW-Authenticate`
 * header - the SDK's transport turns that into an exception that has already
 * discarded the header, which is precisely the piece discovery needs. Two
 * JSON-RPC calls is a small price for seeing the response.
 */

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "agentum", version: "1.0.0" } as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const MAX_TOOL_PAGES = 5;
const ERROR_SNIPPET_LENGTH = 300;

export class McpUnauthorizedError extends Error {
  readonly wwwAuthenticate: string | null;

  constructor(wwwAuthenticate: string | null) {
    super("The MCP server requires authorization.");
    this.name = "McpUnauthorizedError";
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

export interface McpErrorOptions extends ErrorOptions {
  status?: number;
}

export class McpError extends Error {
  readonly status: number | undefined;

  constructor(message: string, options: McpErrorOptions = {}) {
    super(message, options);
    this.name = "McpError";
    this.status = options.status;
  }
}

export interface McpClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Bearer token for an authenticated probe; omitted for the first rung. */
  token?: string;
}

export interface McpProbeResult {
  serverName: string | null;
  tools: CachedTool[];
}

interface JsonRpcResponse {
  error?: { code?: number; message?: string };
  id?: number | string;
  result?: Record<string, unknown>;
}

/**
 * A Streamable HTTP server may answer a POST with either JSON or an SSE stream
 * carrying the same envelope; both are legal, so both are read.
 */
const readEnvelope = async (
  response: Response
): Promise<JsonRpcResponse | null> => {
  const body = await response.text();
  if (body.trim().length === 0) {
    return null;
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body) as JsonRpcResponse;
  }

  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice("data:".length).trim();
    if (payload.length === 0) {
      continue;
    }
    const parsed = JSON.parse(payload) as JsonRpcResponse;
    // Servers interleave notifications; the answer is the frame with a result.
    if (parsed.result || parsed.error) {
      return parsed;
    }
  }
  return null;
};

const describeFailure = async (response: Response): Promise<string> => {
  const body = await response.text().catch(() => "");
  const snippet = body.slice(0, ERROR_SNIPPET_LENGTH).trim();
  return snippet.length > 0
    ? `The MCP server answered ${response.status}: ${snippet}`
    : `The MCP server answered ${response.status}.`;
};

interface Session {
  id: string | null;
}

const callRpc = async (
  url: string,
  options: McpClientOptions,
  session: Session,
  request: { method: string; params?: Record<string, unknown> }
): Promise<JsonRpcResponse | null> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const isNotification = request.method.startsWith("notifications/");

  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (session.id) {
    headers["mcp-session-id"] = session.id;
    headers["mcp-protocol-version"] = PROTOCOL_VERSION;
  }

  const response = await fetchImpl(url, {
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: request.method,
      params: request.params ?? {},
      ...(isNotification ? {} : { id: 1 }),
    }),
    headers,
    method: "POST",
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  // 403 rides with 401 here: a server that rejects an absent or stale token
  // that way still means "authorize", and the ladder must not stop at it.
  if (response.status === UNAUTHORIZED || response.status === FORBIDDEN) {
    throw new McpUnauthorizedError(response.headers.get("www-authenticate"));
  }
  if (!response.ok) {
    throw new McpError(await describeFailure(response), {
      status: response.status,
    });
  }

  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId) {
    session.id = sessionId;
  }

  let envelope: JsonRpcResponse | null;
  try {
    envelope = await readEnvelope(response);
  } catch (error) {
    throw new McpError("The MCP server sent a malformed response.", {
      cause: error,
    });
  }
  if (envelope?.error) {
    throw new McpError(
      envelope.error.message ?? "The MCP server reported an error."
    );
  }
  return envelope;
};

const toolsFrom = (
  result: Record<string, unknown> | undefined
): CachedTool[] =>
  Array.isArray(result?.tools)
    ? result.tools.flatMap((entry) => {
        const tool = entry as { description?: unknown; name?: unknown };
        return typeof tool.name === "string"
          ? [
              {
                description:
                  typeof tool.description === "string"
                    ? tool.description
                    : null,
                name: tool.name,
              },
            ]
          : [];
      })
    : [];

const listTools = async (
  url: string,
  options: McpClientOptions,
  session: Session
): Promise<CachedTool[]> => {
  const tools: CachedTool[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    // Sequential by necessity: each page's cursor comes from the one before.
    // biome-ignore lint/performance/noAwaitInLoops: cursor pagination is inherently serial
    const envelope = await callRpc(url, options, session, {
      method: "tools/list",
      params: cursor ? { cursor } : {},
    });
    tools.push(...toolsFrom(envelope?.result));

    const next = envelope?.result?.nextCursor;
    if (typeof next !== "string" || next.length === 0) {
      break;
    }
    cursor = next;
  }
  return tools;
};

/**
 * One round trip through the handshake and the tool list. Throws
 * `McpUnauthorizedError` (the ladder's trigger), `McpError`, or whatever
 * `fetch` threw for a connection failure.
 */
export const probeMcpServer = async (
  rawUrl: string,
  options: McpClientOptions = {}
): Promise<McpProbeResult> => {
  const url = assertSafeUrl(rawUrl).toString();
  const session: Session = { id: null };

  const initialized = await callRpc(url, options, session, {
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: CLIENT_INFO,
      protocolVersion: PROTOCOL_VERSION,
    },
  });

  // Required by the spec before any other request, and answered with 202 and no
  // body. A server that rejects it is not a reason to fail the probe.
  await callRpc(url, options, session, {
    method: "notifications/initialized",
  }).catch(() => null);

  const serverInfo = initialized?.result?.serverInfo as
    | { name?: unknown }
    | undefined;

  return {
    serverName: typeof serverInfo?.name === "string" ? serverInfo.name : null,
    tools: await listTools(url, options, session),
  };
};
