import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import type { Principal } from "@repo/services/workspaces";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { type Composed, compose } from "../compose";
import { readCappedBody } from "../mcp/body";
import type { AppEnv } from "../routes/groups";
import { authenticateRoomRequest } from "./auth";
import { roomStub } from "./namespace";
import { requiredLive } from "./required";

interface RouteDeps {
  authenticate: (
    env: Env,
    composed: Composed,
    request: Request
  ) => Promise<Principal | null>;
  compose: (env: Env) => Composed;
  room: typeof roomStub;
}
const defaults: RouteDeps = {
  authenticate: authenticateRoomRequest,
  compose: (env) => compose(env, false),
  room: roomStub,
};
/** Mounted before Clerk. The initial request retains real bearer/cookie auth all
 * the way to room admission. A ticket alone never creates a principal. */
export const liveRoomRoutes = (deps: RouteDeps = defaults) =>
  new Hono<AppEnv>().get("/api/rooms/:artifactId", async (c) => {
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      return c.text("WebSocket required", 426);
    }
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin) {
      return c.text("Access denied", 403);
    }
    const ticket = c.req.query("ticket");
    if (!ticket || ticket.length > 8192) {
      return c.text("Access denied", 403);
    }
    try {
      const composed = deps.compose(c.env);
      const principal = await deps.authenticate(c.env, composed, c.req.raw);
      if (!principal || principal.kind === "system") {
        return c.text("Unauthorized", 401);
      }
      const live = composed.services.liveArtifacts;
      if (!live) {
        return c.text("Unavailable", 503);
      }
      await live.admit(principal, {
        artifactId: c.req.param("artifactId"),
        ticket,
      });
      await c.env.LIVE_ARTIFACT_MAINTENANCE.getByName("maintenance").start();
      const room = await deps.room(c.env.ARTIFACT_ROOM, {
        artifactId: c.req.param("artifactId"),
        workspaceId: principal.workspaceId,
      });
      return room.fetch(c.req.raw);
    } catch {
      return c.text("Access denied", 403);
    }
  });

const imageForm = async (request: Request) => {
  const body = await readCappedBody(request, 8 * 1024 * 1024 + 65_536);
  if (!body.ok) {
    return body;
  }
  const form = await new Request(request.url, {
    body: body.bytes,
    headers: request.headers,
    method: "POST",
  })
    .formData()
    .catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return {
      error: "Expected multipart field file",
      ok: false as const,
      status: 400 as const,
    };
  }
  return { file, ok: true as const };
};
export const liveImageRoutes = () =>
  new Hono<AppEnv>()
    .onError((error, c) => {
      if (isForbiddenError(error)) {
        return c.json({ error: "Forbidden" }, 403);
      }
      if (isServiceError(error)) {
        return c.json(
          { error: error.message },
          error.code === "not_found" ? 404 : 400
        );
      }
      throw error;
    })
    .get("/api/live-artifacts/:artifactId/policy", async (c) => {
      const composed = c.get("composed");
      const principal = await authenticateRoomRequest(
        c.env,
        composed,
        c.req.raw
      );
      if (!principal) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const result = await requiredLive(composed.services).policy(principal, {
        artifactId: c.req.param("artifactId"),
      });
      return c.json(result, 200, {
        "Cache-Control": "no-store",
      });
    })
    .get("/api/live-artifacts/:artifactId/markdown", async (c) => {
      const composed = c.get("composed");
      const principal = await authenticateRoomRequest(
        c.env,
        composed,
        c.req.raw
      );
      if (!principal) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const result = await requiredLive(composed.services).exportMarkdown(
        principal,
        { artifactId: c.req.param("artifactId") }
      );
      return c.json(
        {
          filename: `${c.req.param("artifactId")}.md`,
          markdown: result.markdown,
        },
        200,
        { "Cache-Control": "no-store" }
      );
    })
    .use("/api/live-artifacts/:artifactId/images", csrf())
    .post("/api/live-artifacts/:artifactId/images", async (c) => {
      const composed = c.get("composed");
      const principal = await authenticateRoomRequest(
        c.env,
        composed,
        c.req.raw
      );
      if (!principal) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const live = composed.services.liveArtifacts;
      if (!live) {
        return c.json({ error: "Unavailable" }, 503);
      }
      const form = await imageForm(c.req.raw);
      if (!form.ok) {
        return c.json({ error: form.error }, form.status);
      }
      await c.env.LIVE_ARTIFACT_MAINTENANCE.getByName("maintenance").start();
      const result = await live.uploadImage(principal, {
        artifactId: c.req.param("artifactId"),
        body: form.file,
        name: form.file.name,
      });
      return c.json({ ...result, alt: form.file.name }, 201);
    });
