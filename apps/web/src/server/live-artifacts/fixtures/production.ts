// Test-only entrypoint. No fixture endpoint is exported by the production Worker.

import { importRunTokenKey, signRunToken } from "@repo/services/run-tokens";
import { Hono } from "hono";
import { compose } from "../../compose";
import type { AppEnv } from "../../routes/groups";
import { mcpRoutes } from "../../routes/mcp";
import { authenticateRoomRequest } from "../auth";
import { requiredLive } from "../required";
import { liveRoomRoutes } from "../routes";

export { LiveArtifactMaintenance } from "../maintenance";
export { ArtifactRoom } from "../production-room";

const app = new Hono<AppEnv>();
app.route("/", liveRoomRoutes());
app.use("*", async (c, next) => {
  c.set("composed", compose(c.env, false));
  await next();
});
app.route(
  "/mcp",
  mcpRoutes({
    clientName: () => async () => null,
    dev: true,
    isOrgMember: () => async () => false,
    verifyOAuthToken: () => async () => null,
  })
);
app.post("/fixture/token", async (c) =>
  c.json({
    token: await signRunToken(await importRunTokenKey(c.env.RUN_TOKEN_KEY), {
      agentId: "a1",
      issuedAt: Date.now(),
      runId: "r1",
      workspaceId: "w1",
    }),
  })
);
app.post("/fixture/join/:id", async (c) => {
  const composed = c.get("composed");
  const principal = await authenticateRoomRequest(c.env, composed, c.req.raw);
  if (!principal) {
    return c.text("Unauthorized", 401);
  }
  return c.json(
    await requiredLive(composed.services).join(principal, {
      artifactId: c.req.param("id"),
    })
  );
});
app.post("/fixture/checkpoint/:id", async (c) => {
  const composed = c.get("composed");
  const principal = await authenticateRoomRequest(c.env, composed, c.req.raw);
  if (!principal) {
    return c.text("Unauthorized", 401);
  }
  const room = await composed.services.liveRoom?.(principal, c.req.param("id"));
  if (!room) {
    return c.text("Unavailable", 503);
  }
  return c.json(await room.checkpoint());
});
app.get("/fixture/persisted/:id", async (c) => {
  const composed = c.get("composed");
  const principal = await authenticateRoomRequest(c.env, composed, c.req.raw);
  if (!principal) {
    return c.text("Unauthorized", 401);
  }
  return c.json(
    await requiredLive(composed.services).exportMarkdown(principal, {
      artifactId: c.req.param("id"),
    })
  );
});
export default { fetch: app.fetch };
