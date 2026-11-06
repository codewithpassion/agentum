// The platform MCP endpoint, `/mcp`, and each workspace's own address,
// `/mcp/<workspaceId>`, which serves the same server. Bearer authenticated: an
// `ag_key_` API key, or the `hm_run_` token of a running agent. Per request it
// resolves the principal, builds the tool ports bound to it and hands the
// request to an MCP handler made for that request alone, so nothing is shared
// between callers. A Clerk OAuth token is accepted too, once its client is
// approved in the workspace the address names, or for bare `/mcp` in the
// user's home workspace (`oauth-auth.ts`). A platform token on a workspace's
// address must belong to that workspace. Mount with
// `accessRoutes.route("/mcp", mcpRoutes({ ... }))`.

import { readCappedBody } from "@repo/app-gateway/body";
import { createAgentumMcpServer } from "@repo/mcp/server";
import { isReadOnly } from "@repo/services/automation-access";
import type { Principal } from "@repo/services/workspaces";
import { createMcpHandler } from "agents/mcp/server";
import type { Context } from "hono";
import { artifactTestBrowser } from "../browser-run.ts";
import { OAuthVerificationUnavailableError } from "../mcp/clerk-oauth.ts";
import { guestMcpServer } from "../mcp/guest-server";
import {
  isWorkspaceIdShape,
  LOCAL_HOSTNAMES,
  MCP_ROUTE,
  mcpOrigin,
  resourceMetadataUrl,
  workspaceMcpRoute,
} from "../mcp/metadata.ts";
import { OAuthDeniedError, type TargetWorkspace } from "../mcp/oauth-auth.ts";
import {
  createMcpPorts,
  resolveRunBrowser,
  resolveRunComputer,
} from "../mcp/ports.ts";
import {
  authenticateBearer,
  type BearerAuthOptions,
} from "../mcp/principal-resolver.ts";
import { type AppEnv, bearerGroup } from "./groups.ts";

/** Largest JSON-RPC request body accepted; a real one is a few KB. */
export const MAX_MCP_BODY_BYTES = 1024 * 1024;

/** Seconds a client waits after a 503 before trying again. */
const RETRY_AFTER_SECONDS = "30";

type LogEntry = Record<string, unknown>;
type RouteContext = Context<AppEnv>;

export interface McpRouteOptions extends BearerAuthOptions {
  /** Runs work after the response. `executionCtx.waitUntil` by default. */
  defer?: (c: RouteContext, work: Promise<unknown>) => void;
  /** A dev build: the local hostnames are accepted besides `PUBLIC_BASE_URL`'s. */
  dev: boolean;
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
  const params = ['realm="agentum"'];
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

const notFound = (): Response =>
  Response.json({ error: "not_found" }, { status: 404 });

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

/** Management access; OAuth write connections get agent tools only. */
const adminAccessOf = (
  principal: Principal
): "admin" | "write" | "oauth-write" | undefined => {
  if (
    principal.kind === "user" &&
    principal.via === "oauth" &&
    principal.oauthClient?.access === "write"
  ) {
    return "oauth-write";
  }
  const access =
    principal.kind === "user" && principal.via === "api_key"
      ? principal.apiKey?.access
      : undefined;
  return access === "write" || access === "admin" ? access : undefined;
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
    : "Open Agentum, then Settings > Connected apps";
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

const rpcId = (body: unknown) =>
  isRecord(body) ? String(body.id ?? "") : undefined;
const handlerBody = (body: unknown) =>
  body === undefined || body === null ? undefined : { parsedBody: body };
export const mcpRoutes = ({
  clientName,
  defer = defaultDefer,
  dev,
  isOrgMember,
  log = defaultLog,
  userOrgIds,
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
  const authenticate = (
    c: RouteContext,
    workspace: TargetWorkspace | null
  ): Promise<Principal | null> =>
    authenticateBearer(
      { composed: c.get("composed"), env: c.env, workspace },
      { clientName, isOrgMember, userOrgIds, verifyOAuthToken },
      c.req.header("Authorization") ?? null
    );

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

  /** A refused OAuth token: its client is not approved, or its user may not act in the workspace. */
  const oauthRefusal = (c: RouteContext, error: OAuthDeniedError): Response => {
    log({
      clientId: error.clientId,
      event: "mcp.denied",
      reason: error.reason,
      userId: error.userId,
      via: "oauth",
    });
    return error.reason === "no_workspace" || error.reason === "not_member"
      ? forbidden()
      : clientNotApproved(error, originOf(c));
  };

  /** A shared credential must open both roles; older daemon credentials stay refused. */
  const machineCredentialRefused = async (
    c: RouteContext,
    principal: Principal | null
  ): Promise<boolean> =>
    principal?.kind === "machine" &&
    !(await c
      .get("composed")
      .services.machines.authenticate(
        c.req.header("Authorization") ?? null,
        "computer"
      ));

  /** The principal that may use `route`, or the response that refuses the request. */
  const principalOrRefusal = async (
    c: RouteContext,
    route: string,
    workspace: TargetWorkspace | null
  ): Promise<
    Extract<Principal, { kind: "machine" | "run" | "user" }> | Response
  > => {
    let principal: Principal | null;
    try {
      principal = await authenticate(c, workspace);
      if (await machineCredentialRefused(c, principal)) {
        log({ event: "mcp.denied", kind: "machine", reason: "kind" });
        return forbidden();
      }
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
        origin ? resourceMetadataUrl(origin, route) : null,
        c.req.header("Authorization") !== undefined
      );
    }
    if (
      principal.kind !== "user" &&
      principal.kind !== "run" &&
      principal.kind !== "machine"
    ) {
      log({ event: "mcp.denied", kind: principal.kind, reason: "kind" });
      return forbidden();
    }
    return refusalOf(principal, workspace) ?? principal;
  };

  /** The 403 for a principal that may not use the address; null when it may. */
  const refusalOf = (
    principal: Extract<Principal, { kind: "machine" | "run" | "user" }>,
    workspace: TargetWorkspace | null
  ): Response | null => {
    // A desk key is for `/api/desk` only, and acts for whoever the header names.
    if (principal.kind === "user" && principal.apiKey?.access === "desk") {
      log({ event: "mcp.denied", reason: "desk_key" });
      return forbidden();
    }
    // A key or token of one workspace never acts in the one the address names.
    if (workspace && principal.workspaceId !== workspace.id) {
      log({ event: "mcp.denied", reason: "workspace_mismatch" });
      return forbidden();
    }
    return null;
  };

  /** The workspace `/mcp/<workspaceId>` names, or null when there is none. */
  const workspaceNamed = async (
    c: RouteContext,
    workspaceId: string
  ): Promise<TargetWorkspace | null> => {
    // Untrusted input: its shape is checked before any query.
    if (!isWorkspaceIdShape(workspaceId)) {
      return null;
    }
    const workspace = await c
      .get("composed")
      .services.workspaces.byId(workspaceId);
    return workspace
      ? { clerkOrgId: workspace.clerkOrgId, id: workspace.id }
      : null;
  };

  /** One MCP request on `route`, acting in `workspace` or, for bare `/mcp`, the token's own. */
  const serve = async (
    c: RouteContext,
    route: string,
    workspace: TargetWorkspace | null
  ): Promise<Response> => {
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
      route,
    };
    // A CORS preflight carries no Authorization header.
    if (c.req.method === "OPTIONS") {
      return createMcpHandler(noServerForPreflight, options).fetch(c.req.raw);
    }

    const principal = await principalOrRefusal(c, route, workspace);
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
    if (principal.kind === "run" && principal.scopeArtifactId) {
      const server = await guestMcpServer({
        composed,
        principal,
        guestsOff: () =>
          Boolean(
            (c.env as Env & { LIVE_GUESTS_OFF?: string }).LIVE_GUESTS_OFF
          ),
        toolCallId: rpcId(parsedBody),
      });
      return createMcpHandler(() => server, options).fetch(
        request,
        handlerBody(parsedBody)
      );
    }
    // The computer tools are for a run whose agent has a computer attached.
    const computer = await resolveRunComputer(composed.services, principal);
    // The browser is on for every run unless its agent's map unplugged it.
    const browser = await resolveRunBrowser(composed.services, principal);
    const ports = createMcpPorts({
      artifactTestBrowser: artifactTestBrowser(c.env.BROWSER),
      computerMachineId: computer?.machineId,
      principal,
      publicBaseUrl: c.env.PUBLIC_BASE_URL,
      relay: composed.relay,
      requestHost: new URL(c.req.url).hostname,
      services: composed.services,
      toolCallId:
        isRecord(parsedBody) &&
        (typeof parsedBody.id === "string" || typeof parsedBody.id === "number")
          ? `${c.req.header("Mcp-Session-Id") ?? "stateless"}:${String(parsedBody.id)}`
          : undefined,
    });
    // The mail tools are for a run whose agent has an active mailbox.
    const hasMailbox =
      await composed.services.mail.agent.hasActiveMailbox(principal);
    const handler = createMcpHandler(
      () =>
        createAgentumMcpServer(ports, {
          dryRun:
            principal.kind === "run" && principal.dryRun === true
              ? {
                  record: (skip) =>
                    composed.services.runs.recordDryRunSkip(
                      principal,
                      principal.runId,
                      skip
                    ),
                }
              : undefined,
          admin: adminAccessOf(principal),
          browser,
          computer: computer ? { desktop: computer.desktop } : undefined,
          mail: hasMailbox,
          qa: true,
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
  };

  routes.all("/", (c) => serve(c, MCP_ROUTE, null));

  routes.all("/:workspaceId", async (c) => {
    let workspace: TargetWorkspace | null;
    try {
      workspace = await workspaceNamed(c, c.req.param("workspaceId"));
    } catch (error: unknown) {
      log({
        event: "mcp.error",
        message: error instanceof Error ? error.message : String(error),
        phase: "workspace",
      });
      return unavailable();
    }
    if (!workspace) {
      log({ event: "mcp.refused", reason: "unknown_workspace", status: 404 });
      return notFound();
    }
    return serve(c, workspaceMcpRoute(workspace.id), workspace);
  });

  return routes;
};
