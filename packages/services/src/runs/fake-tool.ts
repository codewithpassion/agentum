import { type JsonRpcResponse, readEnvelope } from "../connectors/mcp.ts";
import type { Payload } from "../events/payload.ts";

/**
 * The dev-only fake runtime's way to use a connector. It speaks MCP over HTTP
 * to the app's own connector proxy, so the proxy's allow-list and sign-in
 * checks apply exactly as they do for a real agent. Proxy and network failures
 * come back as reply text, never as a throw.
 */

export interface ProxyAccess {
  /** The deployment's origin. Calls go to `${baseUrl}/api/proxy/${connectorId}`. */
  baseUrl: string;
  fetch: (request: Request) => Promise<Response>;
}

export interface ToolRunInput {
  connectors: readonly { id: string; name: string }[];
  proxy: ProxyAccess;
  runToken: string;
  /** The task text. */
  text: string;
}

export interface ToolRunEvent {
  payload: Payload;
  type: "tool.call" | "tool.result";
}

export interface ToolRunResult {
  /** In order; the caller adds seq numbers. */
  events: ToolRunEvent[];
  /** The reply to the person. */
  text: string;
}

const FAKE_MODEL = "fake-tool";
const MARKER = /tool:([A-Za-z0-9_.-]+)/;
const MARKER_ALL = /tool:[A-Za-z0-9_.-]+/g;
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "agentum-fake-tool", version: "1.0.0" } as const;
const FORBIDDEN = 403;
const MAX_OUTPUT_LENGTH = 8000;
const MAX_REPLY_TEXT_LENGTH = 2000;
const UNREACHABLE = "The proxy could not be reached.";
const NO_SENT_ANSWER = "The proxy sent no answer.";
const UNKNOWN_ERROR = "unknown error";
const NO_APP_REPLY =
  "No app is assigned to this agent, so there is no tool to call.";

export const wantsTool = (model: string, text: string): boolean =>
  model === FAKE_MODEL || MARKER.test(text);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const clip = (text: string): string =>
  text.length > MAX_REPLY_TEXT_LENGTH
    ? `${text.slice(0, MAX_REPLY_TEXT_LENGTH)}...`
    : text;

interface ListedTool {
  name: string;
  required: string[];
  textOnly: boolean;
}

const toListedTool = (entry: unknown): ListedTool | null => {
  if (!isRecord(entry) || typeof entry.name !== "string") {
    return null;
  }
  const schema = isRecord(entry.inputSchema) ? entry.inputSchema : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const requiredList: unknown[] = Array.isArray(schema.required)
    ? schema.required
    : [];
  const required = requiredList.filter(
    (name): name is string => typeof name === "string"
  );
  const textOnly = required.every((name) => {
    const property = properties[name];
    return isRecord(property) && property.type === "string";
  });
  return { name: entry.name, required, textOnly };
};

const listedTools = (
  result: Record<string, unknown> | undefined
): ListedTool[] => {
  const entries: unknown[] = Array.isArray(result?.tools) ? result.tools : [];
  return entries.flatMap((entry) => {
    const tool = toListedTool(entry);
    return tool ? [tool] : [];
  });
};

const contentText = (result: Record<string, unknown> | undefined): string => {
  const entries: unknown[] = Array.isArray(result?.content)
    ? result.content
    : [];
  return entries
    .flatMap((entry) =>
      isRecord(entry) && entry.type === "text" && typeof entry.text === "string"
        ? [entry.text]
        : []
    )
    .join("\n");
};

interface RunContext {
  connector: { id: string; name: string };
  events: ToolRunEvent[];
  named: string | null;
  proxy: ProxyAccess;
  requestCount: number;
  runToken: string;
  sessionId: string | null;
  toolName: string | null;
  toolUses: number;
}

type RpcResult =
  | { envelope: JsonRpcResponse | null; ok: true }
  | { ok: false; reply: string };

const failed = (reply: string): RpcResult => ({ ok: false, reply });

const forbiddenReply = async (
  ctx: RunContext,
  response: Response
): Promise<string> => {
  const body: unknown = await response.json().catch(() => null);
  const notAllowed =
    isRecord(body) &&
    body.error === "forbidden" &&
    body.reason === "tool_not_allowed";
  if (notAllowed && ctx.toolName) {
    return `${ctx.toolName} is not on this agent's allowed tools, so the call was refused.`;
  }
  return `The proxy refused the call to ${ctx.connector.name}.`;
};

/** Sends one JSON-RPC message to the proxy. Never throws. */
const rpc = async (
  ctx: RunContext,
  method: string,
  params: Record<string, unknown> = {}
): Promise<RpcResult> => {
  const isNotification = method.startsWith("notifications/");
  const id = isNotification ? null : ctx.requestCount + 1;
  ctx.requestCount += 1;

  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${ctx.runToken}`,
    "content-type": "application/json",
  };
  if (ctx.sessionId) {
    headers["mcp-session-id"] = ctx.sessionId;
  }
  const url = `${ctx.proxy.baseUrl}/api/proxy/${encodeURIComponent(ctx.connector.id)}`;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    ...(id === null ? {} : { id }),
  });

  let response: Response;
  try {
    response = await ctx.proxy.fetch(
      new Request(url, { body, headers, method: "POST" })
    );
  } catch {
    return failed(UNREACHABLE);
  }

  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId) {
    ctx.sessionId = sessionId;
  }
  if (response.status === FORBIDDEN) {
    return failed(await forbiddenReply(ctx, response));
  }
  if (!response.ok) {
    return failed(`The proxy answered ${response.status}.`);
  }

  let envelope: JsonRpcResponse | null;
  try {
    envelope = await readEnvelope(response);
  } catch {
    return failed(UNREACHABLE);
  }
  if (envelope?.error) {
    const message = envelope.error.message ?? UNKNOWN_ERROR;
    return failed(`${ctx.connector.name} could not be used: ${message}`);
  }
  if (!(envelope || isNotification)) {
    return failed(NO_SENT_ANSWER);
  }
  return { envelope, ok: true };
};

/** Adds one `tool.call` and its `tool.result`, with the next toolUseId. */
const recordPair = (
  ctx: RunContext,
  name: string,
  input: Record<string, string>,
  ok: boolean,
  output: string
): void => {
  ctx.toolUses += 1;
  const toolUseId = `fake-tool-${ctx.toolUses}`;
  ctx.events.push({ payload: { input, name, toolUseId }, type: "tool.call" });
  ctx.events.push({
    payload: { ok, output: output.slice(0, MAX_OUTPUT_LENGTH), toolUseId },
    type: "tool.result",
  });
};

const argumentsFor = (
  tool: ListedTool,
  query: string
): Record<string, string> =>
  Object.fromEntries(tool.required.map((name) => [name, query]));

interface ToolCall {
  arguments: Record<string, string>;
  name: string;
}

const chooseCall = (
  named: string | null,
  tools: ListedTool[],
  query: string
): ToolCall | null => {
  if (named) {
    const listed = tools.find((tool) => tool.name === named);
    return {
      arguments: listed ? argumentsFor(listed, query) : {},
      name: named,
    };
  }
  const chosen = tools.find((tool) => tool.textOnly);
  return chosen
    ? { arguments: argumentsFor(chosen, query), name: chosen.name }
    : null;
};

const INITIALIZE_PARAMS = {
  capabilities: {},
  clientInfo: CLIENT_INFO,
  protocolVersion: PROTOCOL_VERSION,
};

/** Runs the steps in order and returns the reply. Failures end the run. */
const drive = async (ctx: RunContext, query: string): Promise<string> => {
  const init = await rpc(ctx, "initialize", INITIALIZE_PARAMS);
  if (!init.ok) {
    recordPair(ctx, "initialize", {}, false, init.reply);
    return init.reply;
  }
  // The notification's outcome is ignored, as the spec allows.
  await rpc(ctx, "notifications/initialized");

  const list = await rpc(ctx, "tools/list");
  if (!list.ok) {
    recordPair(ctx, "tools/list", {}, false, list.reply);
    return list.reply;
  }
  const tools = listedTools(list.envelope?.result);
  recordPair(
    ctx,
    "tools/list",
    {},
    true,
    tools.map((tool) => tool.name).join(", ")
  );

  const call = chooseCall(ctx.named, tools, query);
  if (!call) {
    return `${ctx.connector.name} has no tool that takes only text, so the fake runtime has nothing to call.`;
  }
  ctx.toolName = call.name;

  const outcome = await rpc(ctx, "tools/call", {
    arguments: call.arguments,
    name: call.name,
  });
  if (!outcome.ok) {
    recordPair(ctx, call.name, call.arguments, false, outcome.reply);
    return outcome.reply;
  }
  const result = outcome.envelope?.result;
  const text = contentText(result);
  const isError = result?.isError === true;
  recordPair(ctx, call.name, call.arguments, !isError, text);
  return isError
    ? `${call.name} returned an error: ${clip(text)}`
    : `Used ${call.name}: ${clip(text)}`;
};

/**
 * Calls the named tool, or the first text-only tool, on the first connector.
 * The query is the task text with any `tool:<name>` marker removed.
 */
export const runTool = async (input: ToolRunInput): Promise<ToolRunResult> => {
  const [connector] = input.connectors;
  if (!connector) {
    return { events: [], text: NO_APP_REPLY };
  }
  const stripped = input.text.replace(MARKER_ALL, "").trim();
  const ctx: RunContext = {
    connector,
    events: [],
    named: input.text.match(MARKER)?.[1] ?? null,
    proxy: input.proxy,
    requestCount: 0,
    runToken: input.runToken,
    sessionId: null,
    toolName: null,
    toolUses: 0,
  };
  const text = await drive(ctx, stripped.length > 0 ? stripped : input.text);
  return { events: ctx.events, text };
};
