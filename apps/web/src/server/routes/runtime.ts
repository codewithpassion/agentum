// Runtime lane HTTP routes (machines, files, Slack). Add each route group with
// `runtimeRoutes.route("/api/<prefix>", cookieGroup() | bearerGroup())` and
// nothing else in this app. Never call `use("*")` here: this app is mounted at
// "/", so that would apply to every request.
import { getAuth } from "@clerk/hono";
import { Hono } from "hono";
import { filesRoutes } from "./files.ts";
import type { AppEnv } from "./groups.ts";
import { machineRoutes } from "./machines.ts";

export const runtimeRoutes = new Hono<AppEnv>();

runtimeRoutes.route("/api/machines", machineRoutes());
// Full paths (`/api/files`, `/files/:id`), so it mounts at "/" with its own per-route middleware.
runtimeRoutes.route("/", filesRoutes({ session: (c) => getAuth(c) }));
