// The platform MCP endpoint, `/mcp`. Bearer authenticated: an `hm_key_` API
// key, or the `hm_run_` token of a running agent. Per request it resolves the
// principal, builds the tool ports bound to it and hands the request to an
// MCP handler made for that request alone, so nothing is shared between
// callers. Mount with `accessRoutes.route("/mcp", mcpRoutes({ ... }))`.
import { createHarbourmasterMcpServer } from "@repo/mcp/server";
import { importRunTokenKey } from "@repo/services/run-tokens";
import {
  createPrincipalResolver,
  type Principal,
} from "@repo/services/workspaces";
import { createMcpHandler } from "agents/mcp/server";
import type { Context } from "hono";
import { parseOrgIds } from "../compose.ts";
import { readCappedBody } from "../mcp/body.ts";
import type { OrgMemberCheck } from "../mcp/clerk-membership.ts";
import { createMcpPorts } from "../mcp/ports.ts";
import { type AppEnv, bearerGroup } from "./groups.ts";

/** Largest JSON-RPC request body accepted; a real one is a few KB. */
export const MAX_MCP_BODY_BYTES = 1024 * 1024;

/** Seconds a client waits after a 503 before trying again. */
const RETRY_AFTER_SECONDS = "30";

const DEV_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

type LogEntry = Record<string, unknown>;
type RouteContext = Context<AppEnv>;

export interface McpRouteOptions {
  /** Runs work after the response. `executionCtx.waitUntil` by default. */
  defer?: (c: RouteContext, work: Promise<unknown>) => void;
  /** A dev build: the local hostnames are accepted besides `PUBLIC_BASE_URL`'s. */
  dev: boolean;
  /** The membership check for the bindings of this request. */
  isOrgMember: (env: Env) => OrgMemberCheck;
  /** Structured log line. `console.log` of JSON by default (`wrangler tail`). */
  log?: (entry: LogEntry) => void;
}

/**
 * The hostnames the handler accepts: the deployment's own, plus the local
 * ones in a dev build. A deployment without `PUBLIC_BASE_URL` accepts none,
 * so it fails closed.
 */
export const mcpAllowedHostnames = (
  publicBaseUrl: string | undefined,
  dev: boolean
): string[] => {
  const names = new Set(dev ? DEV_HOSTNAMES : []);
  if (publicBaseUrl) {
    names.add(new URL(publicBaseUrl).hostname);
  }
  return [...names];
};

const defaultLog = (entry: LogEntry) => {
  console.log(JSON.stringify(entry));
};

/** The execution context, or null where there is none (a test). */
const executionContext = (
  c: RouteContext
): Pick<ExecutionContext, "waitUntil"> | null => {
  try {
    return c.executionCtx;
  } catch {
    return null;
  }
};

const defaultDefer = (c: RouteContext, work: Promise<unknown>) => {
  executionContext(c)?.waitUntil(work);
};

const unauthorized = (): Response =>
  Response.json(
    { error: "unauthorized" },
    {
      headers: { "WWW-Authenticate": 'Bearer realm="harbourmaster"' },
      status: 401,
    }
  );

const forbidden = (): Response =>
  Response.json({ error: "forbidden" }, { status: 403 });

/** Authentication could not run (D1, Clerk or a missing key): not the caller's fault. */
const unavailable = (): Response =>
  Response.json(
    { error: "temporarily_unavailable" },
    { headers: { "Retry-After": RETRY_AFTER_SECONDS }, status: 503 }
  );

const refusedBody = (status: 400 | 413, message: string): Response =>
  Response.json(
    { error: { code: -32_600, message }, id: null, jsonrpc: "2.0" },
    { status }
  );

/** The handler answers OPTIONS itself and never builds a server for it. */
const noServerForPreflight = (): never => {
  throw new Error("An MCP preflight never builds a server");
};

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    // Not JSON: the handler answers the parse error itself.
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON-RPC method and, for `tools/call`, the tool name: for the log only. */
const describeCall = (
  body: unknown
): { method: string | null; tool: string | null } => {
  if (Array.isArray(body)) {
    return { method: "batch", tool: null };
  }
  if (!isRecord(body) || typeof body.method !== "string") {
    return { method: null, tool: null };
  }
  const name = isRecord(body.params) ? body.params.name : undefined;
  return {
    method: body.method,
    tool:
      body.method === "tools/call" && typeof name === "string" ? name : null,
  };
};

type RpcBody =
  | { ok: true; parsedBody: unknown; request: Request }
  | { error: string; ok: false; status: 400 | 413 };

/**
 * The request to hand the MCP handler, with its JSON body parsed for the log
 * line. A POST body is capped before anything is buffered; the handler then
 * gets the same bytes in a fresh request.
 */
const readRpcBody = async (raw: Request): Promise<RpcBody> => {
  if (raw.method !== "POST") {
    return { ok: true, parsedBody: undefined, request: raw };
  }
  const read = await readCappedBody(raw, MAX_MCP_BODY_BYTES);
  if (!read.ok) {
    return read;
  }
  return {
    ok: true,
    parsedBody: parseJson(read.bytes),
    request: new Request(raw, { body: read.bytes }),
  };
};

/** Who the log line names: ids only, never a secret. */
const describePrincipal = (principal: Principal): LogEntry => {
  switch (principal.kind) {
    case "user":
      return {
        keyId: principal.apiKey ? principal.apiKey.id : null,
        userId: principal.userId,
        via: principal.via,
        workspaceId: principal.workspaceId,
      };
    case "run":
      return {
        agentId: principal.agentId,
        runId: principal.runId,
        via: "run_token",
        workspaceId: principal.workspaceId,
      };
    default:
      return { kind: principal.kind };
  }
};

export const mcpRoutes = ({
  defer = defaultDefer,
  dev,
  isOrgMember,
  log = defaultLog,
}: McpRouteOptions) => {
  const routes = bearerGroup();

  /** The principal for the request, null for a bad credential. Throws when auth cannot run. */
  const authenticate = async (c: RouteContext): Promise<Principal | null> => {
    const { env } = c;
    const resolver = createPrincipalResolver({
      allowedOrgIds: parseOrgIds(env.ALLOWED_ORG_IDS),
      db: c.get("composed").db,
      isOrgMember: isOrgMember(env),
      runTokenKey: await importRunTokenKey(env.RUN_TOKEN_KEY),
      // Clerk OAuth tokens arrive with the OAuth client gate (M2.2).
      verifyClerkOAuthToken: () => Promise.resolve(null),
    });
    return await resolver.resolve(c.req.header("Authorization") ?? null);
  };

  routes.all("/", async (c) => {
    const allowedHostnames = mcpAllowedHostnames(c.env.PUBLIC_BASE_URL, dev);
    const options = {
      allowedHostnames,
      allowedOriginHostnames: allowedHostnames,
      // Older clients (Claude Desktop through mcp-remote) speak the 2025 lane.
      legacy: "stateless" as const,
      // One server per request, so no event can reach a listen stream.
      maxSubscriptions: 0,
      onerror: (error: Error) =>
        log({ event: "mcp.error", message: error.message }),
      route: "/mcp",
    };
    // A CORS preflight carries no Authorization header.
    if (c.req.method === "OPTIONS") {
      return createMcpHandler(noServerForPreflight, options).fetch(c.req.raw);
    }

    let principal: Principal | null;
    try {
      principal = await authenticate(c);
    } catch (error: unknown) {
      // D1 or Clerk failed, or a key is not configured: an outage, not a bad token.
      log({
        event: "mcp.error",
        message: error instanceof Error ? error.message : String(error),
        phase: "authenticate",
      });
      return unavailable();
    }
    if (!principal) {
      log({ event: "mcp.denied", reason: "credential" });
      return unauthorized();
    }
    if (principal.kind !== "user" && principal.kind !== "run") {
      log({ event: "mcp.denied", kind: principal.kind, reason: "kind" });
      return forbidden();
    }

    const body = await readRpcBody(c.req.raw);
    if (!body.ok) {
      log({ event: "mcp.refused", reason: body.error, status: body.status });
      return refusedBody(body.status, body.error);
    }
    const { parsedBody, request } = body;

    const composed = c.get("composed");
    const ports = createMcpPorts({ principal, services: composed.services });
    const handler = createMcpHandler(
      () => createHarbourmasterMcpServer(ports),
      options
    );
    const started = Date.now();
    const response = await handler.fetch(
      request,
      parsedBody === undefined || parsedBody === null
        ? undefined
        : { parsedBody }
    );
    log({
      event: "mcp.request",
      ms: Date.now() - started,
      ...describeCall(parsedBody),
      status: response.status,
      ...describePrincipal(principal),
    });
    if (response.ok && principal.kind === "user" && principal.apiKey) {
      const { id } = principal.apiKey;
      defer(
        c,
        composed.services.apiKeys
          .touch(id, principal.workspaceId)
          .catch((error: unknown) =>
            log({
              event: "mcp.touch_failed",
              keyId: id,
              message: error instanceof Error ? error.message : String(error),
            })
          )
      );
    }
    return response;
  });

  return routes;
};
