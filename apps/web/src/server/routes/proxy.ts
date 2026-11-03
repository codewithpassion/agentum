// The connector proxy, `/api/proxy/:connectorId`. Bearer authenticated with a
// run token. Claude Code reaches every assigned connector through here, and
// the Worker puts the real credential on the call, so a connector secret never
// leaves it. Per request, in this order: verify the run token (signature, age,
// and the run is `running` with a live lease), find the agent's assignment of
// the connector (403 when there is none), resolve the credential, forward, bound
// the wait by the connector's call timeout, and append one event. A refused
// credential is refreshed once and the call is tried again.
// Mount with `accessRoutes.route("/api/proxy", proxyRoutes())`.

import type { Fetcher } from "@repo/services/connectors/mcp";
import { assertSafeUrl } from "@repo/services/connectors/url";
import type {
  CredentialsService,
  DecryptedCredential,
  NeedsAuth,
} from "@repo/services/credentials";
import type { EventInput, EventsService } from "@repo/services/events";
import type { RunTokenClaims } from "@repo/services/run-tokens";
import { importRunTokenKey, verifyAgentToken } from "@repo/services/run-tokens";
import type { Context } from "hono";
import { readCappedBody } from "../mcp/body.ts";
import { type AppEnv, bearerGroup } from "./groups.ts";
import { filterToolsList } from "./proxy-allowlist.ts";

/** Largest JSON-RPC request body forwarded; a real one is a few KB. */
export const MAX_PROXY_BODY_BYTES = 1024 * 1024;
/** Default wall-clock cap for egress calls (`egress.ts`). The connector proxy uses each connector's `callTimeoutSeconds`. */
export const PROXY_CAP_MS = 5 * 60 * 1000;
const MS_PER_SECOND = 1000;

const RETRY_AFTER_SECONDS = "30";
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const EMPTY_ACCEPTED = 202;
const EMPTY_NO_CONTENT = 204;
const REDIRECT_MIN = 300;
const REDIRECT_MAX = 399;
const RPC_ERROR = -32_000;
const DEFAULT_ACCEPT = "application/json, text/event-stream";
/** What the model client sends that the upstream server may see. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
] as const;

type LogEntry = Record<string, unknown>;
type RouteContext = Context<AppEnv>;

export interface ProxyRouteOptions {
  /** How calls reach the connector. The global `fetch` by default. */
  fetch?: Fetcher;
  /** Structured log line. `console.log` of JSON by default (`wrangler tail`). */
  log?: (entry: LogEntry) => void;
  /** The signal that ends a forwarded call at its limit (ms). `AbortSignal.timeout` by default. */
  timeout?: (ms: number) => AbortSignal;
}

const defaultLog = (entry: LogEntry) => {
  console.log(JSON.stringify(entry));
};

const unauthorized = (): Response =>
  Response.json(
    { error: "unauthorized" },
    {
      headers: { "WWW-Authenticate": 'Bearer realm="agentum"' },
      status: UNAUTHORIZED,
    }
  );

const unavailable = (): Response =>
  Response.json(
    { error: "temporarily_unavailable" },
    { headers: { "Retry-After": RETRY_AFTER_SECONDS }, status: 503 }
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface RpcCall {
  id: string | number | null;
  method: string | null;
  /** The body is a batch, not a JSON object with a method, or has a key a looser parser could read as a protocol key, so the proxy cannot say which tool it calls. An empty body (DELETE) is not. */
  opaque: boolean;
  tool: string | null;
}

const PROTOCOL_KEYS = new Set(["id", "jsonrpc", "method", "name", "params"]);
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches any non-ASCII character
const NON_ASCII = /[^\u0000-\u007f]/;

/**
 * Whether a key could be read as a protocol key by a parser that is looser than
 * `JSON.parse`: Go's decoder matches struct keys without case and with Unicode
 * folding (`paramſ` is `params`). Exact protocol keys are fine.
 */
const ambiguousKey = (key: string): boolean =>
  !PROTOCOL_KEYS.has(key) &&
  (NON_ASCII.test(key) || PROTOCOL_KEYS.has(key.toLowerCase()));

/** The JSON-RPC id, method and (for `tools/call`) tool name, for the answer and the event. */
const describeCall = (bytes: Uint8Array): RpcCall => {
  let body: unknown = null;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // Not JSON: the connector answers the parse error itself.
  }
  if (!isRecord(body)) {
    return { id: null, method: null, opaque: bytes.length > 0, tool: null };
  }
  const { id, method, params } = body;
  const name = isRecord(params) ? params.name : undefined;
  const keys = [
    ...Object.keys(body),
    ...(isRecord(params) ? Object.keys(params) : []),
  ];
  return {
    opaque: typeof method !== "string" || keys.some(ambiguousKey),
    id: typeof id === "string" || typeof id === "number" ? id : null,
    method: typeof method === "string" ? method : null,
    tool: method === "tools/call" && typeof name === "string" ? name : null,
  };
};

/** An MCP error the model reads. HTTP 200, because the transport worked. */
const rpcError = (
  call: RpcCall,
  message: string,
  data: Record<string, unknown> = {}
): Response =>
  Response.json({
    error: { code: RPC_ERROR, data, message },
    id: call.id,
    jsonrpc: "2.0",
  });

/**
 * Whether the agent's tool allowlist (null: every tool) refuses this call. A
 * body the proxy cannot read as one call is refused: a connector may accept
 * more than `JSON.parse` does (NaN, UTF-16), so "not a tools/call" is only
 * known for a body that parsed.
 */
const toolRefused = (
  call: RpcCall,
  allowedTools: readonly string[] | null
): boolean => {
  if (allowedTools === null) {
    return false;
  }
  return (
    call.opaque ||
    (call.method === "tools/call" &&
      (call.tool === null || !allowedTools.includes(call.tool)))
  );
};

/** The tools/list answer cut to the allowed tools; null when it cannot be read. */
const limitToolsList = (
  bytes: Uint8Array<ArrayBuffer>,
  response: Response,
  allowedTools: readonly string[]
): Uint8Array<ArrayBuffer> | null => {
  const filtered = filterToolsList(
    new TextDecoder().decode(bytes),
    response.headers.get("content-type"),
    new Set(allowedTools)
  );
  return filtered === null ? null : new TextEncoder().encode(filtered);
};

const needsAuthText = (refusal: NeedsAuth, origin: string): string => {
  const link = refusal.connectPath ? `${origin}${refusal.connectPath}` : null;
  switch (refusal.cause) {
    case "no_person":
      return "This connector uses a person's login, and this run is not for a person, so there is nothing to connect.";
    case "single_user_machine":
      return "This machine runs every agent as one user, so another person's login cannot be used on it, and this connector takes only people's logins.";
    default:
      return refusal.ownerKind === "agent"
        ? `This connector needs a login for the agent. Open ${link} while signed in to Agentum to connect it.`
        : `This connector needs your login. Open ${link} while signed in to Agentum to connect it.`;
  }
};

const retryText =
  "The connector's login is being renewed. Try the call again in a moment.";

const upstreamHeaders = (
  request: Request,
  credential: { name: string; value: string } | null
): Headers => {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  if (!headers.has("accept")) {
    headers.set("accept", DEFAULT_ACCEPT);
  }
  if (credential) {
    headers.set(credential.name, credential.value);
  }
  return headers;
};

const relay = (
  upstream: Response,
  bytes: Uint8Array<ArrayBuffer>
): Response => {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  const empty = upstream.status === 204 || upstream.status === 202;
  return new Response(empty ? null : bytes, {
    headers,
    status: upstream.status,
  });
};

const BEARER = /^Bearer\s+(.+)$/i;

type Credential = { name: string; value: string } | null;

const BEARER_PREFIX = /^Bearer\s+/i;
const MIN_SECRET_LENGTH = 8;
const REDACTED = "[redacted]";

/** The body with the login blanked out, in case a connector echoes it back to the model. */
const scrub = (
  bytes: Uint8Array<ArrayBuffer>,
  credential: Credential
): Uint8Array<ArrayBuffer> => {
  if (!credential) {
    return bytes;
  }
  const secrets = [
    credential.value,
    credential.value.replace(BEARER_PREFIX, ""),
  ].filter((secret) => secret.length >= MIN_SECRET_LENGTH);
  let text = new TextDecoder().decode(bytes);
  const found = secrets.some((secret) => text.includes(secret));
  if (!found) {
    return bytes;
  }
  for (const secret of secrets) {
    text = text.replaceAll(secret, REDACTED);
  }
  return new TextEncoder().encode(text);
};
type Sent =
  | { bytes: Uint8Array<ArrayBuffer>; ok: true; response: Response }
  | { kind: "timeout" | "unreachable"; ok: false };

/** One try at the connector. A timeout and a dead connection are results, not throws. */
const sendUpstream = async ({
  body,
  credential,
  fetchImpl,
  request,
  signal,
  url,
}: {
  body: Uint8Array<ArrayBuffer>;
  credential: Credential;
  fetchImpl: Fetcher;
  request: Request;
  signal: AbortSignal;
  url: string;
}): Promise<Sent> => {
  try {
    const response = await fetchImpl(url, {
      body: request.method === "POST" ? body : undefined,
      headers: upstreamHeaders(request, credential),
      method: request.method,
      redirect: "manual",
      signal,
    });
    // Read inside the cap too: a server can hold the body open.
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes: scrub(bytes, credential), ok: true, response };
  } catch (error: unknown) {
    // A stalled body can fail with another error, so the signal decides too.
    const timedOut =
      signal.aborted ||
      (error instanceof DOMException && error.name === "TimeoutError");
    return { kind: timedOut ? "timeout" : "unreachable", ok: false };
  }
};

type Recorder = (
  type: EventInput["type"],
  payload: Record<string, string | number | boolean | null>
) => Promise<void>;

/** Appends the request's one event. A log failure must not undo the call. */
const recorder =
  ({
    claims,
    connectorId,
    events,
    log,
    sessionId,
  }: {
    claims: RunTokenClaims;
    connectorId: string;
    events: EventsService;
    log: (entry: LogEntry) => void;
    sessionId: string;
  }): Recorder =>
  async (type, payload) => {
    try {
      await events.append({
        actor: { id: claims.agentId, kind: "agent" },
        agentId: claims.agentId,
        payload: { connectorId, ...payload },
        runId: claims.runId,
        sessionId,
        type,
        workspaceId: claims.workspaceId,
      });
    } catch (error: unknown) {
      log({
        event: "proxy.event_failed",
        message: error instanceof Error ? error.message : String(error),
        type,
      });
    }
  };

const outcomeOf = (status: number): "ok" | "redirect" | "refused" => {
  if (status === UNAUTHORIZED || status === FORBIDDEN) {
    return "refused";
  }
  return status >= REDIRECT_MIN && status <= REDIRECT_MAX ? "redirect" : "ok";
};

/** The answer for a call that got through, with its event. */
const answer = async ({
  allowedTools,
  call,
  note,
  ownerKind,
  record,
  sent,
  started,
}: {
  allowedTools: readonly string[] | null;
  call: RpcCall;
  note: string | null;
  ownerKind: string | null;
  record: Recorder;
  sent: { bytes: Uint8Array<ArrayBuffer>; response: Response };
  started: number;
}): Promise<Response> => {
  const { bytes, response } = sent;
  const { status } = response;
  await record("connector.call", {
    httpStatus: status,
    method: call.method,
    ms: Date.now() - started,
    note,
    outcome: outcomeOf(status),
    ownerKind,
    tool: call.tool,
  });
  if (status === UNAUTHORIZED || status === FORBIDDEN) {
    // Never hand the client a 401: it would start an OAuth flow of its own.
    return rpcError(call, `The connector answered ${status} for this call.`, {
      code: "upstream_refused",
      status,
    });
  }
  if (status >= REDIRECT_MIN && status <= REDIRECT_MAX) {
    return rpcError(
      call,
      "The connector answered with a redirect, which the proxy does not follow."
    );
  }
  if (
    allowedTools &&
    call.method === "tools/list" &&
    response.ok &&
    status !== EMPTY_ACCEPTED &&
    status !== EMPTY_NO_CONTENT
  ) {
    const limited = limitToolsList(bytes, response, allowedTools);
    if (limited === null) {
      return rpcError(
        call,
        "The connector's tool list could not be limited to the tools this agent may use.",
        { code: "tool_list_unreadable" }
      );
    }
    return relay(response, limited);
  }
  return relay(response, bytes);
};

/** The connector's URL if the SSRF guard still allows it, else null. */
const allowedUrl = (raw: string): string | null => {
  try {
    return assertSafeUrl(raw).toString();
  } catch {
    return null;
  }
};

/** A sender for one call. Its single deadline covers a refresh and the second try too. */
const upstreamSender = ({
  limitMs,
  timeout,
  ...rest
}: {
  body: Uint8Array<ArrayBuffer>;
  fetchImpl: Fetcher;
  limitMs: number;
  request: Request;
  timeout: (ms: number) => AbortSignal;
  url: string;
}) => {
  const signal = timeout(limitMs);
  return (credential: Credential) =>
    sendUpstream({ ...rest, credential, signal });
};

/** A login that cannot be used now: it needs a person, or a refresh is under way. */
type Declined = NeedsAuth | { ok: false; reason: "retry" };

type Attempt =
  | { declined: Declined; kind: "declined" }
  | { kind: "sent"; sent: Sent; used: DecryptedCredential | null };

/**
 * One try, and when the connector refuses the login with a 401, one refresh
 * and a second try. Only one caller at a time reaches the token endpoint.
 */
const sendWithRefresh = async ({
  credential,
  credentials,
  send,
  workspaceId,
}: {
  credential: DecryptedCredential | null;
  credentials: CredentialsService;
  send: (credential: Credential) => Promise<Sent>;
  workspaceId: string;
}): Promise<Attempt> => {
  const first = await send(credential ? credential.header : null);
  if (!(credential && first.ok && first.response.status === UNAUTHORIZED)) {
    return { kind: "sent", sent: first, used: credential };
  }
  const refreshed = await credentials.refresh({
    credentialId: credential.id,
    seenVersion: credential.version,
    workspaceId,
  });
  if (refreshed.ok) {
    return {
      kind: "sent",
      sent: await send(refreshed.credential.header),
      used: refreshed.credential,
    };
  }
  return { declined: refreshed, kind: "declined" };
};

/** The answers for a call that did not reach the connector, each with its event. */
const responders = ({
  call,
  origin,
  record,
}: {
  call: RpcCall;
  origin: string;
  record: Recorder;
}) => {
  const askAgain = async (): Promise<Response> => {
    await record("connector.call", {
      method: call.method,
      outcome: "retry",
      tool: call.tool,
    });
    return rpcError(call, retryText, { code: "retry" });
  };

  const refuse = async (refusal: NeedsAuth): Promise<Response> => {
    await record("connector.needs_auth", {
      cause: refusal.cause,
      connectPath: refusal.connectPath,
      method: call.method,
      ownerId: refusal.ownerId,
      ownerKind: refusal.ownerKind,
      tool: call.tool,
    });
    return rpcError(call, needsAuthText(refusal, origin), {
      code: "needs_auth",
      connectPath: refusal.connectPath,
    });
  };

  const addressBlocked = async (): Promise<Response> => {
    await record("connector.call", {
      method: call.method,
      outcome: "blocked",
      tool: call.tool,
    });
    return rpcError(call, "That connector's address is no longer allowed.");
  };

  const toolDenied = async (): Promise<Response> => {
    await record("connector.call", {
      method: call.method,
      note: "tool_not_allowed",
      outcome: "denied",
      tool: call.tool,
    });
    return Response.json(
      { error: "forbidden", reason: "tool_not_allowed" },
      { status: FORBIDDEN }
    );
  };

  const timedOut = async ({
    connectorName,
    limitSeconds,
    ms,
    ownerKind,
  }: {
    connectorName: string;
    limitSeconds: number;
    ms: number;
    ownerKind: string | null;
  }): Promise<Response> => {
    await record("connector.call", {
      limitSeconds,
      method: call.method,
      ms,
      outcome: "timeout",
      ownerKind,
      tool: call.tool,
    });
    const target = call.tool ?? call.method ?? "request";
    return rpcError(
      call,
      `${connectorName} ${target} timed out after ${limitSeconds} s. Try a smaller request or retry.`,
      { code: "timeout" }
    );
  };

  const unreachable = async (): Promise<Response> => {
    await record("connector.call", {
      method: call.method,
      outcome: "unreachable",
      tool: call.tool,
    });
    return rpcError(call, "The connector could not be reached.");
  };

  return {
    addressBlocked,
    toolDenied,
    declined: (result: Declined): Promise<Response> =>
      result.reason === "needs_auth" ? refuse(result) : askAgain(),
    /** A send that failed: a timeout gets the limit's message, a dead connection the other one. */
    failed: (
      kind: "timeout" | "unreachable",
      detail: Parameters<typeof timedOut>[0]
    ): Promise<Response> =>
      kind === "timeout" ? timedOut(detail) : unreachable(),
  };
};

const guardOutbound = async (
  c: RouteContext,
  claims: RunTokenClaims,
  connectorId: string,
  call: RpcCall,
  bytes: Uint8Array<ArrayBuffer>,
  url: string
) => {
  // Every protocol message can carry caller data, including handshakes. Bind
  // the complete client-controlled effect, not just tools/call arguments.
  // The digest preserves byte identity even for invalid UTF-8; the decoded
  // body is included for the existing scrubbed member approval display.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  await c
    .get("composed")
    .services.requests.requireOutbound(
      { ...claims, kind: "run" },
      `${connectorId}/${call.tool ?? call.method ?? "opaque"}`,
      {
        body: new TextDecoder().decode(bytes),
        bodySha256: Array.from(digest, (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join(""),
        headers: Object.fromEntries(upstreamHeaders(c.req.raw, null)),
        method: c.req.method,
        url,
      }
    );
};
export const proxyRoutes = ({
  fetch: fetchImpl = (input, init) => fetch(input, init),
  log = defaultLog,
  timeout = (ms) => AbortSignal.timeout(ms),
}: ProxyRouteOptions = {}) => {
  const routes = bearerGroup();

  /** The run behind the token, null for a bad one. Throws when auth cannot run. */
  const authenticate = async (
    c: RouteContext
  ): Promise<RunTokenClaims | null> => {
    const token = BEARER.exec(c.req.header("Authorization") ?? "")?.[1];
    if (!token) {
      return null;
    }
    const { clock, db } = c.get("composed");
    const result = await verifyAgentToken({
      db,
      key: await importRunTokenKey(c.env.RUN_TOKEN_KEY),
      now: clock.now(),
      token,
    });
    return result.ok && !result.scopeArtifactId ? result.claims : null;
  };

  /** Everything after the token: assignment, credential, forward, answer. */
  const forward = async (
    c: RouteContext,
    claims: RunTokenClaims,
    connectorId: string
  ): Promise<Response> => {
    const { credentials, events } = c.get("composed").services;
    const context = await credentials.runContext(claims);
    if (!context) {
      return unauthorized();
    }
    const resolution = await credentials.resolve({
      agentId: claims.agentId,
      connectorId,
      machineId: context.machineId,
      onBehalfOfUserId: context.onBehalfOfUserId,
      workspaceId: claims.workspaceId,
    });
    if (!resolution.ok && resolution.reason === "not_assigned") {
      log({
        agentId: claims.agentId,
        connectorId,
        event: "proxy.denied",
        reason: "not_assigned",
        runId: claims.runId,
      });
      return Response.json({ error: "forbidden" }, { status: FORBIDDEN });
    }

    const body = await readCappedBody(c.req.raw, MAX_PROXY_BODY_BYTES);
    if (!body.ok) {
      return Response.json({ error: body.error }, { status: body.status });
    }
    const call = describeCall(body.bytes);
    const record = recorder({
      claims,
      connectorId,
      events,
      log,
      sessionId: context.sessionId,
    });
    const { addressBlocked, declined, failed, toolDenied } = responders({
      call,
      origin: new URL(c.req.url).origin,
      record,
    });

    if (!resolution.ok) {
      return await declined(resolution);
    }
    if (toolRefused(call, resolution.allowedTools)) {
      return await toolDenied();
    }
    const url = allowedUrl(resolution.connector.url);
    if (url === null) {
      return await addressBlocked();
    }

    const limitSeconds = resolution.connector.callTimeoutSeconds;
    const started = Date.now();
    const transmit = upstreamSender({
      body: body.bytes,
      fetchImpl,
      limitMs: limitSeconds * MS_PER_SECOND,
      request: c.req.raw,
      timeout,
      url,
    });

    // A 401 does not prove the remote effect was absent. Each actual send,
    // including the post-refresh retry, needs current authorization and its
    // own receipt when a guest is present.
    const send = async (credential: Credential) => {
      await guardOutbound(c, claims, connectorId, call, body.bytes, url);
      return transmit(credential);
    };
    const tried = await sendWithRefresh({
      credential: resolution.credential,
      credentials,
      send,
      workspaceId: claims.workspaceId,
    });
    if (tried.kind === "declined") {
      return await declined(tried.declined);
    }
    const { sent, used } = tried;
    const ownerKind = used ? used.ownerKind : null;
    if (!sent.ok) {
      return await failed(sent.kind, {
        connectorName: resolution.connector.name,
        limitSeconds,
        ms: Date.now() - started,
        ownerKind,
      });
    }
    return await answer({
      allowedTools: resolution.allowedTools,
      call,
      note: resolution.note,
      ownerKind,
      record,
      sent,
      started,
    });
  };

  routes.all("/:connectorId", async (c) => {
    if (c.req.method !== "POST" && c.req.method !== "DELETE") {
      // No server-initiated stream through the proxy: the client carries on without one.
      return new Response(null, {
        headers: { Allow: "POST, DELETE" },
        status: 405,
      });
    }
    let claims: RunTokenClaims | null;
    try {
      claims = await authenticate(c);
    } catch (error: unknown) {
      log({
        event: "proxy.error",
        message: error instanceof Error ? error.message : String(error),
        phase: "authenticate",
      });
      return unavailable();
    }
    if (!claims) {
      return unauthorized();
    }

    try {
      return await forward(c, claims, c.req.param("connectorId"));
    } catch (error: unknown) {
      // D1 failed, or a stored secret cannot be read: an outage, not the caller's fault.
      log({
        event: "proxy.error",
        message: error instanceof Error ? error.message : String(error),
        phase: "forward",
        runId: claims.runId,
      });
      return unavailable();
    }
  });

  return routes;
};
