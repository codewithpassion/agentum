// OAuth discovery documents for the MCP endpoint, under `/.well-known`. Mount
// with `app.route("/.well-known", wellKnownRoutes({ dev }))`. Agentum is
// only the resource server; Clerk is the authorization server. The pure
// document builders live in `../mcp/metadata.ts`.
import type { Context, Hono } from "hono";
import {
  CORS_HEADERS,
  createAuthServerMetadataProxy,
  mcpOrigin,
  protectedResourceMetadata,
  resolveIssuer,
} from "../mcp/metadata.ts";
import { type AppEnv, bearerGroup } from "./groups.ts";

const MCP_ROUTE = "/mcp";

type LogEntry = Record<string, unknown>;
type RouteContext = Context<AppEnv>;
type AuthServerMetadataProxy = ReturnType<typeof createAuthServerMetadataProxy>;

export interface WellKnownOptions {
  /** Clerk's authorization server document, through the cache. Created once per app by default. */
  authServerMetadata?: AuthServerMetadataProxy;
  /** A dev build: the local hostnames are accepted besides `PUBLIC_BASE_URL`'s. */
  dev: boolean;
  /** Structured log line. `console.log` of JSON by default (`wrangler tail`). */
  log?: (entry: LogEntry) => void;
}

const defaultLog = (entry: LogEntry) => {
  console.log(JSON.stringify(entry));
};

const withCors = (response: Response): Response => {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
};

const corsPreflight = (): Response =>
  withCors(new Response(null, { status: 204 }));

/** A JSON error for a `.well-known` document that cannot be served. */
const metadataError = (status: 404 | 500 | 502, error: string): Response =>
  withCors(Response.json({ error }, { status }));

export const wellKnownRoutes = (options: WellKnownOptions): Hono<AppEnv> => {
  const routes = bearerGroup();
  const log = options.log ?? defaultLog;
  const authServerMetadata =
    options.authServerMetadata ?? createAuthServerMetadataProxy();

  /** The origin the client connected to, as far as it may be trusted. */
  const originOf = (c: RouteContext): string | null =>
    mcpOrigin(c.req.url, {
      dev: options.dev,
      forwardedProto: c.req.header("X-Forwarded-Proto"),
      publicBaseUrl: c.env.PUBLIC_BASE_URL,
    });

  /** The issuer, or null after logging why it is misconfigured. */
  const issuerOf = (c: RouteContext): string | null => {
    const result = resolveIssuer(c.env.CLERK_PUBLISHABLE_KEY);
    if (result.ok) {
      return result.issuer;
    }
    log({ event: "mcp.config", message: result.message });
    return null;
  };

  // RFC 9728 protected resource metadata. Clients try the path-suffixed URL
  // first and fall back to the root one; both describe `/mcp`.
  const protectedResource = (c: RouteContext): Response => {
    const origin = originOf(c);
    if (!origin) {
      log({ event: "mcp.config", message: "PUBLIC_BASE_URL is not set" });
      return metadataError(404, "not_found");
    }
    const issuer = issuerOf(c);
    if (!issuer) {
      return metadataError(500, "server_error");
    }
    return withCors(
      Response.json(
        protectedResourceMetadata({ issuer, origin, route: MCP_ROUTE }),
        { headers: { "Cache-Control": "public, max-age=300" } }
      )
    );
  };

  // RFC 8414 metadata of the authorization server, Clerk's own document,
  // for clients on the 2025-03-26 spec that look for it on the MCP server's
  // origin. Current clients read `authorization_servers` and go to Clerk.
  const authServer = async (c: RouteContext): Promise<Response> => {
    const issuer = issuerOf(c);
    if (!issuer) {
      return metadataError(500, "server_error");
    }
    const result = await authServerMetadata(issuer);
    if (!result.ok) {
      log({ event: "mcp.metadata_failed", message: result.message });
      return metadataError(502, "bad_gateway");
    }
    return withCors(
      Response.json(result.document, {
        headers: { "Cache-Control": "public, max-age=300" },
      })
    );
  };

  routes.get("/oauth-protected-resource", protectedResource);
  routes.options("/oauth-protected-resource", corsPreflight);
  routes.get(`/oauth-protected-resource${MCP_ROUTE}`, protectedResource);
  routes.options(`/oauth-protected-resource${MCP_ROUTE}`, corsPreflight);
  routes.get("/oauth-authorization-server", authServer);
  routes.options("/oauth-authorization-server", corsPreflight);
  routes.get(`/oauth-authorization-server${MCP_ROUTE}`, authServer);
  routes.options(`/oauth-authorization-server${MCP_ROUTE}`, corsPreflight);

  return routes;
};
