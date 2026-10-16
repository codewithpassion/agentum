#!/usr/bin/env bun
import { parseArgs } from "node:util";
// A stub remote MCP server for tests and hand testing. It speaks MCP Streamable
// HTTP with JSON responses only, on POST /mcp, and offers one tool, `echo`. Auth
// is a bearer token. `failOnce` expires the token on first use, so a client has
// to call POST /token to get a new one. Run it directly to start it on a port
// and print its URL and token. Run from the repo root.
import { serve, sleep } from "bun";

const DEFAULT_TOKEN = "stub-token";
const PROTOCOL_VERSION = "2025-06-18";
const BEARER = /^Bearer\s+(.+)$/i;
const NOTIFICATION_PREFIX = "notifications/";

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
  /** Log each POST /token call to stdout and serve GET /_stats. */
  countTokenCalls?: boolean;
  /** The first request with the configured token gets a 401 and expires it. */
  failOnce?: boolean;
  /** Port to listen on. 0 picks a free port. */
  port?: number;
  /** Seconds that `tools/call` waits before it answers. */
  sleepSeconds?: number;
  /** Bearer token that clients must send. `null` turns auth off. */
  token?: string | null;
}

export interface StubMcp {
  port: number;
  stats: () => StubStats;
  stop: () => void;
  url: string;
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

/** Starts the stub server on 127.0.0.1 and returns a handle to stop it. */
export const startStubMcp = (options: StubMcpOptions = {}): StubMcp => {
  const token = options.token === undefined ? DEFAULT_TOKEN : options.token;
  const sleepSeconds = options.sleepSeconds ?? 0;
  const failOnce = options.failOnce ?? false;
  const countTokenCalls = options.countTokenCalls ?? false;

  // Token that the server accepts right now. `null` means none is valid.
  let validToken: string | null = token;
  let tripped = false;
  let refreshCount = 0;
  const state: StubStats = { calls: [], tokenCalls: 0 };

  const snapshot = (): StubStats => structuredClone(state);

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

  const handleMcp = async (request: Request): Promise<Response> => {
    if (!authorised(request)) {
      return unauthorised();
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
    return await handleRpc(body, sleepSeconds);
  };

  const issueToken = (): Response => {
    if (token === null) {
      return new Response("Not found", { status: 404 });
    }
    refreshCount += 1;
    state.tokenCalls += 1;
    validToken = `${token}-refreshed-${refreshCount}`;
    if (countTokenCalls) {
      process.stdout.write(`token-calls=${state.tokenCalls}\n`);
    }
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
    if (request.method === "POST" && pathname === "/token") {
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
    port,
    stats: snapshot,
    stop: () => {
      server.stop(true);
    },
    url: `http://127.0.0.1:${port}/mcp`,
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

const runCli = (argv: string[]): void => {
  const flags = parseArgs({
    allowPositionals: false,
    args: argv,
    options: {
      "count-token-calls": { type: "boolean" },
      "fail-once": { type: "boolean" },
      "no-auth": { type: "boolean" },
      port: { type: "string" },
      sleep: { type: "string" },
      token: { type: "string" },
    },
    strict: true,
  }).values;
  const token =
    flags["no-auth"] === true ? null : (flags.token ?? DEFAULT_TOKEN);
  const stub = startStubMcp({
    countTokenCalls: flags["count-token-calls"] === true,
    failOnce: flags["fail-once"] === true,
    port: parsePort(flags.port),
    sleepSeconds: parseSleep(flags.sleep),
    token,
  });
  process.stdout.write(
    `url: ${stub.url}\ntoken: ${token ?? "(none, no auth)"}\n`
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
