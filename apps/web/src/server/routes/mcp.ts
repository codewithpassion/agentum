// The platform MCP endpoint, `/mcp`. Bearer authenticated: an `hm_key_` API
// key, or the `hm_run_` token of a running agent. Per request it resolves the
// principal, builds the tool ports bound to it and hands the request to an
// MCP handler made for that request alone, so nothing is shared between
// callers. A Clerk OAuth token is accepted too, once its client is approved
// (`oauth-auth.ts`). Mount with `accessRoutes.route("/mcp", mcpRoutes({ ... }))`.
import { createHarbourmasterMcpServer } from "@repo/mcp/server";
import { isReadOnly } from "@repo/services/automation-access";
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
import {
  OAuthVerificationUnavailableError,
  type VerifiedOAuthToken,
} from "../mcp/clerk-oauth.ts";
import {
  LOCAL_HOSTNAMES,
  mcpOrigin,
  resourceMetadataUrl,
} from "../mcp/metadata.ts";
import { OAuthDeniedError, oauthClaimVerifier } from "../mcp/oauth-auth.ts";
import { createMcpPorts } from "../mcp/ports.ts";
import { type AppEnv, bearerGroup } from "./groups.ts";

/** Largest JSON-RPC request body accepted; a real one is a few KB. */
export const MAX_MCP_BODY_BYTES = 1024 * 1024;

/** Seconds a client waits after a 503 before trying again. */
const RETRY_AFTER_SECONDS = "30";

const MCP_ROUTE = "/mcp";

type LogEntry = Record<string, unknown>;
type RouteContext = Context<AppEnv>;

export interface McpRouteOptions {
  /** The name of an OAuth application, asked when its client is first seen. */
  clientName: (env: Env) => (clientId: string) => Promise<string | null>;
  /** Runs work after the response. `executionCtx.waitUntil` by default. */
  defer?: (c: RouteContext, work: Promise<unknown>) => void;
  /** A dev build: the local hostnames are accepted besides `PUBLIC_BASE_URL`'s. */
  dev: boolean;
  /** The membership check for the bindings of this request. */
  isOrgMember: (env: Env) => OrgMemberCheck;
  /** Structured log line. `console.log` of JSON by default (`wrangler tail`). */
  log?: (entry: LogEntry) => void;
  /** Clerk's verdict on an OAuth access token for the bindings of this request. */
  verifyOAuthToken: (
    env: Env
  ) => (token: string) => Promise<VerifiedOAuthToken | null>;
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
  const names = new Set(dev ? LOCAL_HOSTNAMES : []);
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

/**
 * The 401 (RFC 6750, RFC 9728 5.1). The challenge names the protected resource
 * metadata so an OAuth client can find Clerk and start consent; without a
 * trusted origin the parameter is left out rather than guessed. A request
 * with no token gets the bare challenge, one with a bad token `invalid_token`.
 */
const unauthorized = (
  metadataUrl: string | null,
  hadToken: boolean
): Response => {
  const params = ['realm="harbourmaster"'];
  if (metadataUrl) {
    params.push(`resource_metadata="${metadataUrl}"`);
  }
  if (hadToken) {
    params.push('error="invalid_token"');
  }
  return Response.json(
    { error: hadToken ? "invalid_token" : "unauthorized" },
    {
      headers: { "WWW-Authenticate": `Bearer ${params.join(", ")}` },
      status: 401,
    }
  );
};

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
        clientId: principal.oauthClient ? principal.oauthClient.clientId : null,
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

/** The 403 for an OAuth client nobody approved yet: the token is fine, so no challenge. */
const clientNotApproved = (
  error: OAuthDeniedError,
  origin: string | null
): Response => {
  const where = origin
    ? `Open ${origin}/settings/connected-apps`
    : "Open Harbourmaster, then Settings > Connected apps";
  const state =
    error.reason === "revoked" ? "was revoked" : "is not approved yet";
  return Response.json(
    {
      error: "client_not_approved",
      // By client id: the app's own name is chosen by whoever registered it.
      message: `This app ${state}. ${where}, approve the app with client id ${error.clientId}, then reconnect.`,
    },
    { status: 403 }
  );
};

export const mcpRoutes = ({
  clientName,
  defer = defaultDefer,
  dev,
  isOrgMember,
  log = defaultLog,
  verifyOAuthToken,
}: McpRouteOptions) => {
  const routes = bearerGroup();

  /** The origin the client connected to, as far as it may be trusted. */
  const originOf = (c: RouteContext): string | null =>
    mcpOrigin(c.req.url, {
      dev,
      forwardedProto: c.req.header("X-Forwarded-Proto"),
      publicBaseUrl: c.env.PUBLIC_BASE_URL,
    });

  /** The principal for the request, null for a bad credential. Throws when auth cannot run. */
  const authenticate = async (c: RouteContext): Promise<Principal | null> => {
    const { env } = c;
    const composed = c.get("composed");
    const allowedOrgIds = parseOrgIds(env.ALLOWED_ORG_IDS);
    const resolver = createPrincipalResolver({
      allowedOrgIds,
      db: composed.db,
      isOrgMember: isOrgMember(env),
      runTokenKey: await importRunTokenKey(env.RUN_TOKEN_KEY),
      // Only a token that is not an `hm_` credential gets here.
      verifyClerkOAuthToken: oauthClaimVerifier({
        allowedOrgIds,
        clientName: (clientId) => clientName(env)(clientId),
        isOrgMember: (userId, clerkOrgId) =>
          isOrgMember(env)(userId, clerkOrgId),
        oauthClients: composed.services.oauthClients,
        verify: (token) => verifyOAuthToken(env)(token),
        workspaces: composed.services.workspaces,
      }),
    });
    return await resolver.resolve(c.req.header("Authorization") ?? null);
  };

  /** Runs a last-used stamp after the response. A failure is only logged. */
  const deferTouch = (
    c: RouteContext,
    credential: Record<string, string>,
    work: Promise<unknown>
  ) => {
    defer(
      c,
      work.catch((error: unknown) =>
        log({
          event: "mcp.touch_failed",
          ...credential,
          message: error instanceof Error ? error.message : String(error),
        })
      )
    );
  };

  /** After a successful call: stamp the key or OAuth client last used. */
  const recordUse = (
    c: RouteContext,
    principal: Extract<Principal, { kind: "user" }>
  ) => {
    const { services } = c.get("composed");
    const { apiKey, oauthClient, workspaceId } = principal;
    if (apiKey) {
      deferTouch(
        c,
        { keyId: apiKey.id },
        services.apiKeys.touch(apiKey.id, workspaceId)
      );
    }
    if (oauthClient) {
      deferTouch(
        c,
        { clientId: oauthClient.clientId },
        services.oauthClients.touch(oauthClient.clientId, workspaceId)
      );
    }
  };

  /** A refused OAuth token: its client is not approved, or its user has no workspace here. */
  const oauthRefusal = (c: RouteContext, error: OAuthDeniedError): Response => {
    log({
      clientId: error.clientId,
      event: "mcp.denied",
      reason: error.reason,
      userId: error.userId,
      via: "oauth",
    });
    return error.reason === "no_workspace"
      ? forbidden()
      : clientNotApproved(error, originOf(c));
  };

  /** The principal that may use `/mcp`, or the response that refuses the request. */
  const principalOrRefusal = async (
    c: RouteContext
  ): Promise<Extract<Principal, { kind: "run" | "user" }> | Response> => {
    let principal: Principal | null;
    try {
      principal = await authenticate(c);
    } catch (error: unknown) {
      if (error instanceof OAuthDeniedError) {
        return oauthRefusal(c, error);
      }
      // D1 or Clerk failed, or a key is not configured: an outage, not a bad token.
      log({
        event: "mcp.error",
        message: error instanceof Error ? error.message : String(error),
        // Clerk refused our secret key: a configuration error, not an outage.
        misconfigured:
          error instanceof OAuthVerificationUnavailableError &&
          error.misconfigured,
        phase: "authenticate",
      });
      return unavailable();
    }
    if (!principal) {
      log({ event: "mcp.denied", reason: "credential" });
      const origin = originOf(c);
      return unauthorized(
        origin ? resourceMetadataUrl(origin, MCP_ROUTE) : null,
        c.req.header("Authorization") !== undefined
      );
    }
    if (principal.kind !== "user" && principal.kind !== "run") {
      log({ event: "mcp.denied", kind: principal.kind, reason: "kind" });
      return forbidden();
    }
    return principal;
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
      route: MCP_ROUTE,
    };
    // A CORS preflight carries no Authorization header.
    if (c.req.method === "OPTIONS") {
      return createMcpHandler(noServerForPreflight, options).fetch(c.req.raw);
    }

    const principal = await principalOrRefusal(c);
    if (principal instanceof Response) {
      return principal;
    }

    const body = await readRpcBody(c.req.raw);
    if (!body.ok) {
      log({ event: "mcp.refused", reason: body.error, status: body.status });
      return refusedBody(body.status, body.error);
    }
    const { parsedBody, request } = body;

    const composed = c.get("composed");
    const ports = createMcpPorts({
      principal,
      publicBaseUrl: c.env.PUBLIC_BASE_URL,
      requestHost: new URL(c.req.url).hostname,
      services: composed.services,
    });
    const handler = createMcpHandler(
      () =>
        createHarbourmasterMcpServer(ports, {
          readOnly: isReadOnly(principal),
        }),
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
    if (response.ok && principal.kind === "user") {
      recordUse(c, principal);
    }
    return response;
  });

  return routes;
};
