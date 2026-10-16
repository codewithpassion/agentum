// Runtime lane HTTP routes (machines, files, Slack). Add each route group with
// `runtimeRoutes.route("/api/<prefix>", cookieGroup() | bearerGroup())` and
// nothing else in this app. Never call `use("*")` here: this app is mounted at
// "/", so that would apply to every request.
import { Hono } from "hono";
import type { AppEnv } from "./groups.ts";
import { machineRoutes } from "./machines.ts";

export const runtimeRoutes = new Hono<AppEnv>();

runtimeRoutes.route("/api/machines", machineRoutes());
