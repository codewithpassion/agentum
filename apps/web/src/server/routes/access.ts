// Access lane HTTP routes (MCP, API keys, connectors, proxy). Add each route group with
// `accessRoutes.route("/api/<prefix>", cookieGroup() | bearerGroup())` and
// nothing else in this app. Never call `use("*")` here: this app is mounted at
// "/", so that would apply to every request.
import { Hono } from "hono";
import { clerkOrgMemberCheck } from "../mcp/clerk-membership.ts";
import type { AppEnv } from "./groups.ts";
import { mcpRoutes } from "./mcp.ts";

export const accessRoutes = new Hono<AppEnv>();

// The platform MCP server. Bearer authenticated, so it has no csrf check.
accessRoutes.route(
  "/mcp",
  mcpRoutes({
    dev: import.meta.env.DEV,
    isOrgMember: (env) => clerkOrgMemberCheck(env.CLERK_SECRET_KEY),
  })
);
