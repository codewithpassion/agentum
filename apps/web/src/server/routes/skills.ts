// Skill HTTP routes for the daemon: the file list `GET /api/runs/:id/skills`
// and the bytes `GET /api/runs/:id/skills/file?path=`. Only a run token
// (`hm_run_`, bearer) authenticates them; the cookie session is never read.
// The service decides what the run may read, so this file only authenticates
// and maps refusals to statuses. Mount with `runtimeRoutes.route("/", skillsRoutes())`,
// because the paths are full, not prefixed.

import { skillsListResponseSchema } from "@repo/protocol/skills";
import { bearerToken } from "@repo/services/workspaces";
import type { Context } from "hono";
import { Hono } from "hono";
import { runPrincipal } from "./files.ts";
import type { AppEnv } from "./groups.ts";
import { jsonError, serviceRefusal } from "./respond.ts";

const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;

const INVALID_TOKEN = "Invalid run token.";

type RouteContext = Context<AppEnv>;

/** The run a bearer `hm_run_` token names, or null. Cookies are never read. */
const authenticateRun = (c: RouteContext) => {
  const token = bearerToken(c.req.header("Authorization") ?? null);
  return token ? runPrincipal(c, token) : Promise.resolve(null);
};

export const skillsRoutes = (): Hono<AppEnv> => {
  const routes = new Hono<AppEnv>();

  routes.get("/api/runs/:id/skills", async (c) => {
    const principal = await authenticateRun(c);
    if (!principal) {
      return jsonError(c, UNAUTHORIZED, INVALID_TOKEN);
    }
    try {
      const files = await c
        .get("composed")
        .services.runSkills.list(principal, c.req.param("id"));
      // The wire format has no executable flag, so a daemon built before SK.2 still parses it.
      return c.json(
        skillsListResponseSchema.parse({
          files: files.map(({ etag, path, size }) => ({ etag, path, size })),
        })
      );
    } catch (error: unknown) {
      return serviceRefusal(c, error);
    }
  });

  routes.get("/api/runs/:id/skills/file", async (c) => {
    const principal = await authenticateRun(c);
    if (!principal) {
      return jsonError(c, UNAUTHORIZED, INVALID_TOKEN);
    }
    const path = c.req.query("path");
    if (path === undefined) {
      return jsonError(c, BAD_REQUEST, "Expected a path query parameter.");
    }
    try {
      const bytes = await c
        .get("composed")
        .services.runSkills.read(principal, c.req.param("id"), path);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Length": String(bytes.byteLength),
          "Content-Type": "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error: unknown) {
      return serviceRefusal(c, error);
    }
  });

  return routes;
};
