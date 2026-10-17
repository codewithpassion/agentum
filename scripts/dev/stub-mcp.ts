#!/usr/bin/env bun
import { Buffer } from "node:buffer";
import { parseArgs } from "node:util";
// A stub remote MCP server for tests and hand testing. It speaks MCP Streamable
// HTTP with JSON responses only, on POST /mcp, and offers one tool, `echo`. Auth
// is a bearer token. `failOnce` expires the token on first use, so a client has
// to call POST /token to get a new one. `oauth` swaps that for an OAuth 2.1
// authorization server (PKCE, dynamic client registration), and /mcp then takes
// only the access tokens it issued. `stateful` hands out an Mcp-Session-Id on
// initialize and requires it on later requests. Run it directly to start it on
// a port and print its URL and token. Run from the repo root.
import { serve, sleep } from "bun";

const DEFAULT_TOKEN = "stub-token";
const PROTOCOL_VERSION = "2025-06-18";
const BEARER = /^Bearer\s+(.+)$/i;
const NOTIFICATION_PREFIX = "notifications/";
const SESSION_HEADER = "Mcp-Session-Id";
const OAUTH_SCOPE = "read";
const HTML_ESCAPES: Record<string, string> = {
  "'": "&#39;",
  '"': "&quot;",
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

const ECHO_TOOL = {
  description: "Echo the text back",
  inputSchema: {
    properties: { text: { type: "string" } },
    required: ["text"],
    type: "object",
  },
  name: "echo",
};

export interface StubStats {
  calls: { method: string; headers: Record<string, string> }[];
  tokenCalls: number;
}

export interface StubMcpOptions {
  /** Log each token call to stdout and serve GET /_stats. */
  countTokenCalls?: boolean;
  /** The first request with the configured token gets a 401 and expires it. */
  failOnce?: boolean;
  /**
   * Act as an OAuth authorization server. /mcp accepts only access tokens from
   * /oauth/token, and `token` and `failOnce` do not apply.
   */
  oauth?: boolean;
  /** Port to listen on. 0 picks a free port. */
  port?: number;
  /** Seconds that `tools/call` waits before it answers. */
  sleepSeconds?: number;
  /**
   * Hand out an Mcp-Session-Id on `initialize` and require it on every other
   * /mcp request. `dropSessions` forgets them, as a server restart would.
   */
  stateful?: boolean;
  /** Bearer token that clients must send. `null` turns auth off. */
  token?: string | null;
}

export interface StubMcp {
  /** Forget every session, as a server restart would. Does nothing when stateless. */
  dropSessions: () => void;
  port: number;
  stats: () => StubStats;
  stop: () => void;
  url: string;
}

type Handler = (request: Request) => Response | Promise<Response>;

interface PendingCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const bearerOf = (request: Request): string | undefined =>
  BEARER.exec(request.headers.get("authorization") ?? "")?.[1];

const jsonRpcResult = (id: string | number | null, result: unknown) =>
  Response.json({ id, jsonrpc: "2.0", result });

const jsonRpcError = (
  id: string | number | null,
  code: number,
  message: string,
  status = 200
) =>
  Response.json({ error: { code, message }, id, jsonrpc: "2.0" }, { status });

const unauthorised = () =>
  new Response(null, {
    headers: { "WWW-Authenticate": 'Bearer realm="stub-mcp"' },
    status: 401,
  });

const firstValue = (value: string | null): string | undefined => {
  const first = value?.split(",")[0]?.trim();
  return first || undefined;
};

/** The public origin of a request. A tunnel passes the real one in X-Forwarded-*. */
const originOf = (request: Request): string => {
  const protocol =
    firstValue(request.headers.get("x-forwarded-proto")) ?? "http";
  const host =
    firstValue(request.headers.get("x-forwarded-host")) ??
    firstValue(request.headers.get("host")) ??
    new URL(request.url).host;
  return `${protocol}://${host}`;
};

const oauthChallenge = (request: Request): Response =>
  new Response(null, {
    headers: {
      "WWW-Authenticate": `Bearer realm="stub-mcp", resource_metadata="${originOf(request)}/.well-known/oauth-protected-resource"`,
    },
    status: 401,
  });

const oauthError = (error: string, status = 400): Response =>
  Response.json({ error }, { status });

const plainBadRequest = (message: string): Response =>
  new Response(message, { status: 400 });

const requestIdOf = (body: Record<string, unknown>): string | number | null =>
  typeof body.id === "string" || typeof body.id === "number" ? body.id : null;

const callEcho = async (
  id: string | number | null,
  params: unknown,
  sleepSeconds: number
): Promise<Response> => {
  const args = isRecord(params) ? params.arguments : undefined;
  const text = isRecord(args) ? args.text : undefined;
  if (typeof text !== "string") {
    return jsonRpcError(id, -32_602, "Invalid params");
  }
  if (sleepSeconds > 0) {
    await sleep(sleepSeconds * 1000);
  }
  return jsonRpcResult(id, { content: [{ text, type: "text" }] });
};

const handleRpc = (
  body: Record<string, unknown>,
  sleepSeconds: number
): Promise<Response> | Response => {
  const { method } = body;
  if (typeof method !== "string") {
    return jsonRpcError(null, -32_600, "Invalid Request", 400);
  }
  if (method.startsWith(NOTIFICATION_PREFIX)) {
    return new Response(null, { status: 202 });
  }
  const id = requestIdOf(body);
  switch (method) {
    case "initialize":
      return jsonRpcResult(id, {
        capabilities: { tools: {} },
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: "stub-mcp", version: "1.0.0" },
      });
    case "tools/list":
      return jsonRpcResult(id, { tools: [ECHO_TOOL] });
    case "tools/call": {
      const { params } = body;
      const name = isRecord(params) ? params.name : undefined;
      if (name !== ECHO_TOOL.name) {
        return jsonRpcError(id, -32_601, "Method not found");
      }
      return callEcho(id, params, sleepSeconds);
    }
    default:
      return jsonRpcError(id, -32_601, "Method not found");
  }
};

const s256 = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return Buffer.from(digest).toString("base64url");
};

const randomString = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

const readJson = (request: Request): Promise<unknown> =>
  request.json().catch(() => undefined);

const isUriList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === "string" && URL.canParse(item));

const escapeHtml = (value: string): string =>
  value.replaceAll(/["&'<>]/g, (char) => HTML_ESCAPES[char] ?? char);

const redirectLink = (
  redirectUri: string,
  fields: Record<string, string | null>
): string => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
};

const consentPage = (
  clientId: string,
  approve: string,
  deny: string
) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Stub MCP consent</title></head>
<body>
<h1>Stub MCP consent</h1>
<p>Client <code>${escapeHtml(clientId)}</code> asks to use this server.</p>
<p><a id="approve" href="${escapeHtml(approve)}">Approve</a> <a id="deny" href="${escapeHtml(deny)}">Deny</a></p>
</body>
</html>
`;

const protectedResourceMetadata = (origin: string) => ({
  authorization_servers: [origin],
  resource: `${origin}/mcp`,
  scopes_supported: [OAUTH_SCOPE],
});

const authorizationServerMetadata = (origin: string) => ({
  authorization_endpoint: `${origin}/oauth/authorize`,
  code_challenge_methods_supported: ["S256"],
  issuer: origin,
  registration_endpoint: `${origin}/oauth/register`,
  scopes_supported: [OAUTH_SCOPE],
  token_endpoint: `${origin}/oauth/token`,
  token_endpoint_auth_methods_supported: ["none"],
});

const protectedResource: Handler = (request) =>
  Response.json(protectedResourceMetadata(originOf(request)));

const authorizationServer: Handler = (request) =>
  Response.json(authorizationServerMetadata(originOf(request)));

/** Returns why an authorize request is refused, or undefined when it is valid. */
const authorizeProblem = (
  params: URLSearchParams,
  clients: Map<string, string[]>
): string | undefined => {
  const clientId = params.get("client_id");
  const redirectUris = clientId === null ? undefined : clients.get(clientId);
  if (redirectUris === undefined) {
    return "Unknown client_id";
  }
  const redirectUri = params.get("redirect_uri");
  if (redirectUri === null || !redirectUris.includes(redirectUri)) {
    return "redirect_uri is not registered for this client";
  }
  if (
    params.get("code_challenge_method") !== "S256" ||
    params.get("code_challenge") === null
  ) {
    return "code_challenge_method must be S256 and code_challenge is required";
  }
};

/** One OAuth authorization server, with its clients, codes and tokens. */
const createOAuth = (recordTokenCall: () => void) => {
  const clients = new Map<string, string[]>();
  const codes = new Map<string, PendingCode>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Set<string>();
  let issued = 0;

  const nextNumber = (): number => {
    issued += 1;
    return issued;
  };

  const issueTokens = (): Response => {
    const n = nextNumber();
    const accessToken = `stub-at-${n}`;
    const refreshToken = `stub-rt-${n}`;
    accessTokens.add(accessToken);
    refreshTokens.add(refreshToken);
    return Response.json({
      access_token: accessToken,
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: OAUTH_SCOPE,
      token_type: "Bearer",
    });
  };

  // A code is single use. It is removed even when the exchange then fails.
  const takeCode = (code: string | null): PendingCode | undefined => {
    if (code === null) {
      return;
    }
    const pending = codes.get(code);
    codes.delete(code);
    return pending;
  };

  const exchangeCode = async (form: URLSearchParams): Promise<Response> => {
    const pending = takeCode(form.get("code"));
    if (
      pending === undefined ||
      pending.clientId !== form.get("client_id") ||
      pending.redirectUri !== form.get("redirect_uri")
    ) {
      return oauthError("invalid_grant");
    }
    const challenge = await s256(form.get("code_verifier") ?? "");
    return challenge === pending.codeChallenge
      ? issueTokens()
      : oauthError("invalid_grant");
  };

  // Refresh tokens rotate: each one works once and returns a new pair.
  const refreshGrant = (form: URLSearchParams): Response => {
    const token = form.get("refresh_token");
    if (token === null || !refreshTokens.delete(token)) {
      return oauthError("invalid_grant");
    }
    return issueTokens();
  };

  const tokenEndpoint: Handler = async (request) => {
    recordTokenCall();
    const form = new URLSearchParams(await request.text());
    switch (form.get("grant_type")) {
      case "authorization_code":
        return await exchangeCode(form);
      case "refresh_token":
        return refreshGrant(form);
      default:
        return oauthError("unsupported_grant_type");
    }
  };

  const registerClient: Handler = async (request) => {
    const body = await readJson(request);
    const redirectUris = isRecord(body) ? body.redirect_uris : undefined;
    if (!isUriList(redirectUris)) {
      return oauthError("invalid_client_metadata");
    }
    const clientId = `stub-client-${nextNumber()}`;
    clients.set(clientId, redirectUris);
    return Response.json(
      {
        client_id: clientId,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
      },
      { status: 201 }
    );
  };

  const authorize: Handler = (request) => {
    const params = new URL(request.url).searchParams;
    const problem = authorizeProblem(params, clients);
    if (problem !== undefined) {
      return plainBadRequest(problem);
    }
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const state = params.get("state");
    const code = randomString();
    codes.set(code, {
      clientId,
      codeChallenge: params.get("code_challenge") ?? "",
      redirectUri,
    });
    const approve = redirectLink(redirectUri, { code, state });
    const deny = redirectLink(redirectUri, { error: "access_denied", state });
    return new Response(consentPage(clientId, approve, deny), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };

  const routes = new Map<string, Handler>([
    ["GET /.well-known/oauth-protected-resource", protectedResource],
    ["GET /.well-known/oauth-protected-resource/mcp", protectedResource],
    ["GET /.well-known/oauth-authorization-server", authorizationServer],
    ["GET /.well-known/oauth-authorization-server/mcp", authorizationServer],
    ["GET /oauth/authorize", authorize],
    ["POST /oauth/register", registerClient],
    ["POST /oauth/token", tokenEndpoint],
  ]);

  return {
    isAuthorised: (request: Request): boolean => {
      const bearer = bearerOf(request);
      return bearer !== undefined && accessTokens.has(bearer);
    },
    route: (
      request: Request,
      pathname: string
    ): Response | Promise<Response> | undefined =>
      routes.get(`${request.method} ${pathname}`)?.(request),
  };
};

const parsePort = (value: string | undefined): number => {
  if (value === undefined) {
    return 0;
  }
  const port = Number(value);
  if (!(Number.isInteger(port) && port >= 0 && port <= 65_535)) {
    throw new Error(`--port must be an integer from 0 to 65535, got ${value}`);
  }
  return port;
};

const parseSleep = (value: string | undefined): number => {
  if (value === undefined) {
    return 0;
  }
  const seconds = Number(value);
  if (!(Number.isFinite(seconds) && seconds >= 0)) {
    throw new Error(`--sleep must be a number of seconds, got ${value}`);
  }
  return seconds;
};

/** Starts the stub server on 127.0.0.1 and returns a handle to stop it. */
export const startStubMcp = (options: StubMcpOptions = {}): StubMcp => {
  const token = options.token === undefined ? DEFAULT_TOKEN : options.token;
  const sleepSeconds = options.sleepSeconds ?? 0;
  const failOnce = options.failOnce ?? false;
  const countTokenCalls = options.countTokenCalls ?? false;
  const sessions = options.stateful === true ? new Set<string>() : undefined;

  // Token that the server accepts right now. `null` means none is valid.
  let validToken: string | null = token;
  let tripped = false;
  let refreshCount = 0;
  const state: StubStats = { calls: [], tokenCalls: 0 };

  const snapshot = (): StubStats => structuredClone(state);

  const recordTokenCall = (): void => {
    state.tokenCalls += 1;
    if (countTokenCalls) {
      process.stdout.write(`token-calls=${state.tokenCalls}\n`);
    }
  };

  const oauthServer =
    options.oauth === true ? createOAuth(recordTokenCall) : undefined;

  const authorised = (request: Request): boolean => {
    if (token === null) {
      return true;
    }
    const bearer = bearerOf(request);
    if (bearer === undefined || bearer !== validToken) {
      return false;
    }
    if (failOnce && !tripped && bearer === token) {
      tripped = true;
      validToken = null;
      return false;
    }
    return true;
  };

  const mcpAccessDenied = (request: Request): Response | undefined => {
    if (oauthServer !== undefined) {
      return oauthServer.isAuthorised(request)
        ? undefined
        : oauthChallenge(request);
    }
    return authorised(request) ? undefined : unauthorised();
  };

  const sessionDenied = (
    request: Request,
    id: string | number | null
  ): Response | undefined => {
    if (sessions === undefined) {
      return;
    }
    const sessionId = request.headers.get(SESSION_HEADER) ?? "";
    if (sessionId === "") {
      return jsonRpcError(
        id,
        -32_000,
        "Bad Request: Mcp-Session-Id header is required",
        400
      );
    }
    return sessions.has(sessionId)
      ? undefined
      : jsonRpcError(id, -32_001, "Session not found", 404);
  };

  const handleMcp = async (request: Request): Promise<Response> => {
    const denied = mcpAccessDenied(request);
    if (denied !== undefined) {
      return denied;
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonRpcError(null, -32_700, "Parse error", 400);
    }
    if (!isRecord(body)) {
      return jsonRpcError(null, -32_600, "Invalid Request", 400);
    }
    if (typeof body.method === "string") {
      state.calls.push({
        headers: Object.fromEntries(request.headers),
        method: body.method,
      });
    }
    if (body.method !== "initialize") {
      const rejected = sessionDenied(request, requestIdOf(body));
      if (rejected !== undefined) {
        return rejected;
      }
    }
    const response = await handleRpc(body, sleepSeconds);
    if (sessions !== undefined && body.method === "initialize" && response.ok) {
      const sessionId = crypto.randomUUID();
      sessions.add(sessionId);
      response.headers.set(SESSION_HEADER, sessionId);
    }
    return response;
  };

  const issueToken = (): Response => {
    if (token === null) {
      return new Response("Not found", { status: 404 });
    }
    refreshCount += 1;
    recordTokenCall();
    validToken = `${token}-refreshed-${refreshCount}`;
    return Response.json({
      access_token: validToken,
      expires_in: 3600,
      refresh_token: "stub-refresh",
      token_type: "Bearer",
    });
  };

  const route = (request: Request): Promise<Response> | Response => {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/mcp") {
      return handleMcp(request);
    }
    if (oauthServer !== undefined) {
      const oauthResponse = oauthServer.route(request, pathname);
      if (oauthResponse !== undefined) {
        return oauthResponse;
      }
    } else if (request.method === "POST" && pathname === "/token") {
      return issueToken();
    }
    if (countTokenCalls && request.method === "GET" && pathname === "/_stats") {
      return Response.json(snapshot());
    }
    return new Response("Not found", { status: 404 });
  };

  const server = serve({
    fetch: route,
    hostname: "127.0.0.1",
    // A `--sleep` call can outlast Bun's default idle timeout.
    idleTimeout: 0,
    port: options.port ?? 0,
  });

  const { port } = server;
  if (port === undefined) {
    throw new Error("The stub server is not listening on a TCP port.");
  }

  return {
    dropSessions: () => {
      sessions?.clear();
    },
    port,
    stats: snapshot,
    stop: () => {
      server.stop(true);
    },
    url: `http://127.0.0.1:${port}/mcp`,
  };
};

const runCli = (argv: string[]): void => {
  const flags = parseArgs({
    allowPositionals: false,
    args: argv,
    options: {
      "count-token-calls": { type: "boolean" },
      "fail-once": { type: "boolean" },
      "no-auth": { type: "boolean" },
      oauth: { type: "boolean" },
      port: { type: "string" },
      sleep: { type: "string" },
      stateful: { type: "boolean" },
      token: { type: "string" },
    },
    strict: true,
  }).values;
  const token =
    flags["no-auth"] === true ? null : (flags.token ?? DEFAULT_TOKEN);
  const stub = startStubMcp({
    countTokenCalls: flags["count-token-calls"] === true,
    failOnce: flags["fail-once"] === true,
    oauth: flags.oauth === true,
    port: parsePort(flags.port),
    sleepSeconds: parseSleep(flags.sleep),
    stateful: flags.stateful === true,
    token,
  });
  const oauthLine = flags.oauth === true ? "oauth: on\n" : "";
  const statefulLine = flags.stateful === true ? "stateful: on\n" : "";
  process.stdout.write(
    `url: ${stub.url}\ntoken: ${token ?? "(none, no auth)"}\n${oauthLine}${statefulLine}`
  );
};

if (import.meta.main) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
