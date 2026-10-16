// Access lane HTTP routes (MCP, API keys, connectors, proxy). Add each route group with
// `accessRoutes.route("/api/<prefix>", cookieGroup() | bearerGroup())` and
// nothing else in this app. Never call `use("*")` here: this app is mounted at
// "/", so that would apply to every request.
import { getAuth } from "@clerk/hono";
import { Hono } from "hono";
import { clerkOrgMemberCheck } from "../mcp/clerk-membership.ts";
import {
  clerkOAuthClientName,
  clerkOAuthTokenVerifier,
} from "../mcp/clerk-oauth-client.ts";
import { connectorOAuthRoutes } from "./connectors-oauth.ts";
import type { AppEnv } from "./groups.ts";
import { mcpRoutes } from "./mcp.ts";
import { proxyRoutes } from "./proxy.ts";
import { wellKnownRoutes } from "./well-known.ts";

export const accessRoutes = new Hono<AppEnv>();

// The platform MCP server. Bearer authenticated, so it has no csrf check.
accessRoutes.route(
  "/mcp",
  mcpRoutes({
    clientName: (env) => clerkOAuthClientName(env.CLERK_SECRET_KEY),
    dev: import.meta.env.DEV,
    isOrgMember: (env) => clerkOrgMemberCheck(env.CLERK_SECRET_KEY),
    verifyOAuthToken: (env) => clerkOAuthTokenVerifier(env.CLERK_SECRET_KEY),
  })
);

// OAuth discovery for /mcp: Clerk is the authorization server.
accessRoutes.route(
  "/.well-known",
  wellKnownRoutes({ dev: import.meta.env.DEV })
);

// Connecting a connector with OAuth. Cookie session only. Full paths
// (`/connect/:id`, `/api/connectors/oauth/callback`), so it mounts at "/".
accessRoutes.route("/", connectorOAuthRoutes({ session: (c) => getAuth(c) }));

// The connector proxy. Bearer authenticated with a run token, so no csrf check.
accessRoutes.route("/api/proxy", proxyRoutes());
