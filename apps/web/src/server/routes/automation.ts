// Automation lane HTTP routes (triggers, routines). Add each route group with
// `automationRoutes.route("/api/<prefix>", cookieGroup() | bearerGroup())` and
// nothing else in this app. Never call `use("*")` here: this app is mounted at
// "/", so that would apply to every request.
import { Hono } from "hono";
import type { AppEnv } from "./groups.ts";

export const automationRoutes = new Hono<AppEnv>();
