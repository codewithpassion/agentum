// Access lane HTTP routes (MCP, API keys, connectors, proxy). Add each route group with
// `accessRoutes.route("/api/<prefix>", cookieGroup() | bearerGroup())` and
// nothing else in this app. Never call `use("*")` here: this app is mounted at
// "/", so that would apply to every request.
import { Hono } from "hono";
import type { AppEnv } from "./groups.ts";

export const accessRoutes = new Hono<AppEnv>();
