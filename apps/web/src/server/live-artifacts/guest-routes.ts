import { guestVerifySchema } from "@repo/protocol/guest";
import { createGuestArtifacts } from "@repo/services/live-guests/artifacts";
import { createGuestScopeDiscovery } from "@repo/services/live-guests/http-scope";
import {
  clearGuestSessionCookie,
  GUEST_COOKIE,
} from "@repo/services/live-guests/security";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { type Composed, compose } from "../compose";
import type { AppEnv } from "../routes/groups";
import { relay } from "../routes/session-stream";
import {
  guestActions,
  guestImages,
  guestJson,
  scopedGuests,
} from "./guest-actions";
import { guestOpenMetadata } from "./guest-metadata";
import { guestReplay, guestStream } from "./guest-stream";
import { roomStub } from "./namespace";

const cookieToken = (cookie: string) =>
  cookie.split(";")[0]?.slice(GUEST_COOKIE.length + 1) ?? "";

export interface GuestRouteDeps {
  compose: (env: Env) => Composed;
  page?: (request: Request) => Promise<Response>;
}
export const guestRoutes = (
  deps: GuestRouteDeps = { compose: (env) => compose(env, false) }
) => {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (
      !(c.req.path.startsWith("/api/guest/") || c.req.path.startsWith("/g/"))
    ) {
      await next();
      return;
    }
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    const { origin } = new URL(c.req.url);
    if (
      (c.req.method !== "GET" || c.req.header("Upgrade")) &&
      c.req.header("Origin") !== origin
    ) {
      return c.json({ error: "Guest access unavailable" }, 403);
    }
    if (
      c.req.method !== "GET" &&
      c.req.header("Sec-Fetch-Site") === "cross-site"
    ) {
      return c.json({ error: "Guest access unavailable" }, 403);
    }
    c.set("composed", deps.compose(c.env));
    await next();
  });
  app.onError((_error, c) =>
    c.json({ error: "Guest access unavailable" }, 404)
  );
  app.get("/g/:inviteToken", async (c) => {
    if (deps.page && c.req.header("Accept")?.includes("text/html")) {
      return deps.page(c.req.raw);
    }
    const composed = c.get("composed");
    const token = c.req.param("inviteToken");
    const workspace = await createGuestScopeDiscovery(composed.db).invitation(
      token
    );
    const service = await composed.services.liveGuests?.();
    const landing =
      workspace && service ? await service.invitation(workspace, token) : null;
    if (!landing) {
      throw new Error("Unavailable");
    }
    return c.json(landing);
  });
  app.post("/api/guest/:inviteToken/code", async (c) => {
    try {
      const composed = c.get("composed");
      const token = c.req.param("inviteToken");
      const workspaceId = await createGuestScopeDiscovery(
        composed.db
      ).invitation(token);
      const service = await composed.services.liveGuests?.();
      if (workspaceId && service) {
        await service.requestCode({
          inviteToken: token,
          ip: c.req.header("CF-Connecting-IP") ?? "",
          workspaceId,
        });
      }
    } catch {
      /* Deliberately indistinguishable, including infrastructure failure. */
    }
    return c.json({ accepted: true });
  });
  app.post("/api/guest/:inviteToken/verify", async (c) => {
    const { code } = guestVerifySchema.parse(await guestJson(c.req.raw));
    const composed = c.get("composed");
    const token = c.req.param("inviteToken");
    const workspaceId = await createGuestScopeDiscovery(composed.db).invitation(
      token
    );
    const service = await composed.services.liveGuests?.();
    if (!(workspaceId && service)) {
      throw new Error("Unavailable");
    }
    const result = await service.verify({
      code,
      inviteToken: token,
      ip: c.req.header("CF-Connecting-IP"),
      userAgent: c.req.header("User-Agent"),
      workspaceId,
    });
    c.header("Set-Cookie", result.cookie);
    return c.json({
      expiresAt: result.expiresAt,
      grant: result.grant,
      location: result.location,
    });
  });
  app.post("/api/guest/signout", async (c) => {
    const composed = c.get("composed");
    const sessionToken = getCookie(c, GUEST_COOKIE) ?? "";
    const workspaceId = await createGuestScopeDiscovery(composed.db).session(
      sessionToken
    );
    const service = await composed.services.liveGuests?.();
    const result =
      workspaceId && service
        ? await service.signout({ sessionToken, workspaceId })
        : { cookie: clearGuestSessionCookie() };
    c.header("Set-Cookie", result.cookie);
    return c.json({ signedOut: true });
  });
  app.get("/g/a/:artifactId", (c) =>
    deps.page && c.req.header("Accept")?.includes("text/html")
      ? deps.page(c.req.raw)
      : app.fetch(
          new Request(
            new URL(
              `/api/guest/artifacts/${encodeURIComponent(c.req.param("artifactId"))}/open`,
              c.req.url
            ),
            c.req.raw
          ),
          c.env
        )
  );
  app.get("/api/guest/artifacts/:artifactId/session/stream", async (c) => {
    const composed = c.get("composed");
    const artifactId = c.req.param("artifactId");
    const workspaceId = await createGuestScopeDiscovery(composed.db).artifact(
      artifactId
    );
    const service = await composed.services.liveGuests?.();
    if (!(workspaceId && service)) {
      throw new Error("Unavailable");
    }
    const credential = {
      artifactId,
      sessionToken: getCookie(c, GUEST_COOKIE) ?? "",
      workspaceId,
    };
    // Rotate first: the cookie may be the previous token of a rotation whose
    // response was lost, and only rotation accepts that. Everything after it
    // authenticates with the replacement token.
    const rotated = await service.renew(credential);
    c.header("Set-Cookie", rotated.cookie);
    credential.sessionToken = cookieToken(rotated.cookie);
    const scoped = scopedGuests(c.env, composed);
    const ref = await scoped.sessionReference(credential);
    const transcript = await scoped.transcript(credential);
    if (!(ref && transcript.sessionId)) {
      throw new Error("Unavailable");
    }
    const live = await c.env.SESSION_STREAM.getByName(
      transcript.sessionId
    ).fetch(
      new Request("https://session-stream/stream", { signal: c.req.raw.signal })
    );
    if (!live.body) {
      throw new Error("Unavailable");
    }
    try {
      const resume = c.req.header("Last-Event-ID") || c.req.query("after");
      const replay = await guestReplay(
        scoped,
        credential,
        resume?.slice(0, 200)
      );
      const body = guestStream(relay(replay, live.body), async () =>
        Boolean(
          await scoped.resolveReference({
            artifactId,
            sessionId: ref.sessionId,
            workspaceId,
          })
        )
      );
      return new Response(body, {
        headers: {
          ...Object.fromEntries(c.res.headers),
          "Cache-Control": "no-store",
          "Content-Type": "text/event-stream",
          "X-Accel-Buffering": "no",
        },
      });
    } catch (error) {
      await live.body.cancel();
      throw error;
    }
  });
  app.get("/api/guest/artifacts/:artifactId/files/:fileId", async (c) => {
    const composed = c.get("composed");
    const artifactId = c.req.param("artifactId");
    const workspaceId = await createGuestScopeDiscovery(composed.db).artifact(
      artifactId
    );
    const service = await composed.services.liveGuests?.();
    if (!(workspaceId && service && composed.services.liveArtifacts)) {
      throw new Error("Unavailable");
    }
    const credential = {
      artifactId,
      sessionToken: getCookie(c, GUEST_COOKIE) ?? "",
      workspaceId,
    };
    const rotated = await service.renew(credential);
    c.header("Set-Cookie", rotated.cookie);
    credential.sessionToken = cookieToken(rotated.cookie);
    const images = guestImages(c.env, composed);
    const image = await images.read(credential, c.req.param("fileId"));
    return new Response(image.body, {
      headers: {
        ...Object.fromEntries(c.res.headers),
        "Cache-Control": "no-store",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Content-Type": image.mime,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  app.all("/api/guest/artifacts/:artifactId/:action", async (c) => {
    const composed = c.get("composed");
    const artifactId = c.req.param("artifactId");
    const action = c.req.param("action");
    const workspaceId = await createGuestScopeDiscovery(composed.db).artifact(
      artifactId
    );
    const service = await composed.services.liveGuests?.();
    if (!(workspaceId && service)) {
      throw new Error("Unavailable");
    }
    const credential = {
      artifactId,
      sessionToken: getCookie(c, GUEST_COOKIE) ?? "",
      workspaceId,
    };
    if (
      action === "room" &&
      c.req.method === "GET" &&
      c.req.header("Upgrade")?.toLowerCase() === "websocket"
    ) {
      // A socket never rotates, so it needs the current token.
      const scoped = createGuestArtifacts({
        ...composed,
        events: composed.services.events,
        guestsOff: () =>
          Boolean(
            (c.env as Env & { LIVE_GUESTS_OFF?: string }).LIVE_GUESTS_OFF
          ),
      });
      const grant = await scoped.current(credential);
      const room = await roomStub(c.env.ARTIFACT_ROOM, grant);
      return room.fetch(c.req.raw);
    }
    const handler = guestActions[action];
    if (!handler || handler.method !== c.req.method) {
      return c.json({ error: "Guest access unavailable" }, 404);
    }
    // Rotation authenticates the request, and alone accepts the previous token.
    const rotated =
      action === "open"
        ? await service.open(credential, guestOpenMetadata(c.req.raw))
        : await service.renew(credential);
    c.header("Set-Cookie", rotated.cookie);
    credential.sessionToken = cookieToken(rotated.cookie);
    const result = await handler.execute({
      composed,
      credential,
      defer: (work) => c.executionCtx.waitUntil(work),
      env: c.env,
      grant: rotated.grant,
      request: c.req.raw,
    });
    return c.json(result);
  });
  return app;
};
