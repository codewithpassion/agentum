// Runtime lane HTTP routes (machines, files, Slack). Add each route group with
// `runtimeRoutes.route("/api/<prefix>", cookieGroup() | bearerGroup())` and
// nothing else in this app. Never call `use("*")` here: this app is mounted at
// "/", so that would apply to every request.
import { getAuth } from "@clerk/hono";
import { Hono } from "hono";
import { desktopRoutes } from "./desktop.ts";
import { filesRoutes } from "./files.ts";
import type { AppEnv } from "./groups.ts";
import { libraryRoutes } from "./library.ts";
import { machineRoutes } from "./machines.ts";
import { runLibraryRoutes } from "./run-library.ts";
import { sessionStreamRoutes } from "./session-stream.ts";
import { skillsRoutes } from "./skills.ts";
import { slackRoutes } from "./slack.ts";

export const runtimeRoutes = new Hono<AppEnv>();

runtimeRoutes.route("/api/machines", machineRoutes());
runtimeRoutes.route(
  "/api/machines/:id/desktop",
  desktopRoutes({ session: (c) => getAuth(c) })
);
// Full paths (`/api/files`, `/files/:id`), so it mounts at "/" with its own per-route middleware.
runtimeRoutes.route("/", filesRoutes({ session: (c) => getAuth(c) }));
runtimeRoutes.route("/", libraryRoutes({ session: (c) => getAuth(c) }));
runtimeRoutes.route("/", skillsRoutes());
runtimeRoutes.route("/", runLibraryRoutes());
runtimeRoutes.route(
  "/api/sessions",
  sessionStreamRoutes({ session: (c) => getAuth(c) })
);
// Slack calls the events URL with a signature, so the group is bearer style.
runtimeRoutes.route("/api/slack", slackRoutes());
