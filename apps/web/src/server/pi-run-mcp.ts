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

/** The session id of each server, by url. The value is the in-flight or finished initialize, and resolves to undefined for a stateless server. */
export type McpSessions = Map<string, Promise<string | undefined>>;

const PROTOCOL_VERSION = "2025-06-18";
const PROTOCOL_HEADER = "Mcp-Protocol-Version";
const SESSION_HEADER = "Mcp-Session-Id";
// A server refuses a request whose session is missing (400) or unknown (404).
const LOST_SESSION_STATUSES: readonly number[] = [400, 404];
// The shared initialize cannot carry a caller's signal, so a server that never answers is cut off here.
const INITIALIZE_TIMEOUT_MS = 30_000;
// The connector limit is 300 s. The grace lets the proxy's own timeout error arrive first.
export const CALL_LIMIT_MS = 310_000;
const MS_PER_SECOND = 1000;
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

// The spec forbids reusing a request id in a session, so every request takes the next one.
let lastRequestId = 0;
const nextRequestId = (): number => {
  lastRequestId += 1;
  return lastRequestId;
};

/** The last `data:` line of an SSE body, or the whole body when it has none. */
const replyText = (text: string): string => {
  const dataLines = text
    .split("\n")
    .filter((line) => line.startsWith(SSE_DATA_PREFIX));
  const last = dataLines.at(-1);
  return last === undefined ? text : last.slice(SSE_DATA_PREFIX_LENGTH).trim();
};

/** A reply with a non-ok status. The status tells a lost session apart from other failures. */
class McpHttpError extends Error {
  readonly status: number;

  constructor(method: string, status: number) {
    super(`MCP ${method} failed: ${status}`);
    this.status = status;
  }
}

const postMcp = (
  server: McpServerEntry,
  fetcher: McpFetch,
  body: unknown,
  extra: Record<string, string>,
  signal?: AbortSignal
): Promise<Response> =>
  fetcher(server.url, {
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json, text/event-stream",
      ...server.headers,
      "Content-Type": "application/json",
      ...extra,
    },
    method: "POST",
    signal,
  });

/** The headers of a request after initialize: the protocol version, and the session id when there is one. */
const sessionHeaders = (session: string | undefined): Record<string, string> =>
  session === undefined
    ? { [PROTOCOL_HEADER]: PROTOCOL_VERSION }
    : { [PROTOCOL_HEADER]: PROTOCOL_VERSION, [SESSION_HEADER]: session };

const resultOf = <T>(text: string): T => {
  const reply: RpcReply = JSON.parse(replyText(text));
  if (reply.error) {
    throw new Error(reply.error.message);
  }
  // The server answers each method with the shape the MCP spec gives it, which the caller names with T.
  return reply.result as T;
};

const rpc = async <T>(
  server: McpServerEntry,
  fetcher: McpFetch,
  method: string,
  params: unknown,
  session: string | undefined,
  signal?: AbortSignal
): Promise<T> => {
  const response = await postMcp(
    server,
    fetcher,
    { id: nextRequestId(), jsonrpc: "2.0", method, params },
    sessionHeaders(session),
    signal
  );
  if (!response.ok) {
    throw new McpHttpError(method, response.status);
  }
  return resultOf<T>(await response.text());
};

/** POSTs initialize, reads the session id, then sends notifications/initialized. Resolves to the session id, or undefined for a stateless server. */
const initialize = async (
  server: McpServerEntry,
  fetcher: McpFetch
): Promise<string | undefined> => {
  const response = await postMcp(
    server,
    fetcher,
    {
      id: nextRequestId(),
      jsonrpc: "2.0",
      method: "initialize",
      params: INITIALIZE_PARAMS,
    },
    {},
    AbortSignal.timeout(INITIALIZE_TIMEOUT_MS)
  );
  if (!response.ok) {
    throw new McpHttpError("initialize", response.status);
  }
  resultOf(await response.text());
  const session = response.headers.get(SESSION_HEADER) ?? undefined;
  // A notification has no reply to wait for, so a refused one is not an error.
  const notified = await postMcp(
    server,
    fetcher,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionHeaders(session),
    AbortSignal.timeout(INITIALIZE_TIMEOUT_MS)
  );
  await notified.body?.cancel();
  return session;
};

/**
 * The session of a server. The first caller starts initialize and stores its
 * promise, so concurrent callers share it. A failed initialize is removed, so the
 * next call tries again.
 */
const sessionOf = (
  server: McpServerEntry,
  fetcher: McpFetch,
  sessions: McpSessions
): Promise<string | undefined> => {
  const known = sessions.get(server.url);
  if (known !== undefined) {
    return known;
  }
  // The shared promise cannot carry the caller's AbortSignal, so initialize runs without one.
  const started: Promise<string | undefined> = initialize(
    server,
    fetcher
  ).catch((error: unknown) => {
    if (sessions.get(server.url) === started) {
      sessions.delete(server.url);
    }
    throw error;
  });
  sessions.set(server.url, started);
  return started;
};

/**
 * Sends a request in the server's session. A request that carried a session id
 * and got 400 or 404 means the server lost the session. Then the session is
 * initialized again and the request is sent once more. A request with no session
 * never retries.
 */
const sessionRpc = async <T>(
  server: McpServerEntry,
  fetcher: McpFetch,
  sessions: McpSessions,
  method: string,
  params: unknown,
  signal?: AbortSignal
): Promise<T> => {
  const started = sessionOf(server, fetcher, sessions);
  const session = await started;
  try {
    return await rpc<T>(server, fetcher, method, params, session, signal);
  } catch (error) {
    if (
      session === undefined ||
      !(error instanceof McpHttpError) ||
      !LOST_SESSION_STATUSES.includes(error.status)
    ) {
      throw error;
    }
    // Another call may have initialized again already, and that session must stay.
    if (sessions.get(server.url) === started) {
      sessions.delete(server.url);
    }
    const renewed = await sessionOf(server, fetcher, sessions);
    return await rpc<T>(server, fetcher, method, params, renewed, signal);
  }
};

/** tools/list in the server's session, initialized first if the session is not known yet. */
export const listMcpTools = async (
  server: McpServerEntry,
  fetcher: McpFetch = defaultFetch,
  sessions: McpSessions = new Map()
): Promise<McpTool[]> => {
  const listed = await sessionRpc<{ tools: McpTool[] }>(
    server,
    fetcher,
    sessions,
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
  onDown: (key: string, error: unknown) => void = () => undefined,
  sessions: McpSessions = new Map()
): Promise<ServerTools> => {
  // Each listing carries its key, so a failure can be matched to its server. The
  // handlers never throw, so Promise.all waits for every server, like allSettled.
  const listings: Listing[] = await Promise.all(
    Object.entries(servers).map(([key, server]) =>
      listMcpTools(server, fetcher, sessions).then(
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
 * changes is picked up and never baked into the tool list. The sessions are keyed
 * by url, so a changed token still uses the same session.
 */
export const mcpToolRegistrations = (
  serverKey: string,
  tools: readonly McpTool[],
  getServer: () => Promise<McpServerEntry>,
  fetcher: McpFetch = defaultFetch,
  onCallError?: () => void,
  sessions: McpSessions = new Map(),
  callLimitMs = CALL_LIMIT_MS
): ToolRegistration[] => {
  // Cutting a long name can make two tools of a server collide, and the registry refuses a repeat.
  const taken = new Set<string>();
  return tools.map(
    (tool): ToolRegistration => ({
      description: tool.description ?? tool.name,
      execute: async (args, _api, context) => {
        const server = await getServer();
        // The call ends at the caller's abort or at the time limit, whichever comes first.
        const timeLimit = AbortSignal.timeout(callLimitMs);
        const signal = AbortSignal.any(
          context.abortSignal === undefined
            ? [timeLimit]
            : [context.abortSignal, timeLimit]
        );
        let result: ToolCallResult;
        try {
          result = await sessionRpc<ToolCallResult>(
            server,
            fetcher,
            sessions,
            "tools/call",
            { arguments: args, name: tool.name },
            signal
          );
        } catch (error) {
          if (timeLimit.aborted && context.abortSignal?.aborted !== true) {
            // A slow connector is a result the model can read, so the run carries on.
            return {
              isError: true,
              output: [
                {
                  text: `${serverKey} ${tool.name} timed out after ${callLimitMs / MS_PER_SECOND} s. Try a smaller request or retry.`,
                  type: "text",
                },
              ],
            };
          }
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
