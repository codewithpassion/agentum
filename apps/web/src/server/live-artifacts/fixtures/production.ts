// biome-ignore-all lint/performance/noBarrelFile: workerd fixture entrypoint must export Durable Object classes.
// Test-only entrypoint. No fixture endpoint is exported by the production Worker.

import { importRunTokenKey, signRunToken } from "@repo/services/run-tokens";
import { Hono } from "hono";
import { mountArtifactContentRoutes } from "../../artifact-content/routes";
import { compose } from "../../compose";
import type { AppEnv } from "../../routes/groups";
import { mcpRoutes } from "../../routes/mcp";
import { authenticateRoomRequest } from "../auth";
import { requiredLive } from "../required";
import { liveImageRoutes, liveRoomRoutes } from "../routes";

export { LiveArtifactMaintenance } from "../maintenance";

import { ArtifactRoom as ProductionRoom } from "../production-room";
export class ArtifactRoom extends ProductionRoom {
  override async alarm() {
    await this.ctx.storage.put("fixtureAlarm", Date.now());
    try {
      await super.alarm();
    } catch (error) {
      await this.ctx.storage.put("fixtureAlarmError", String(error));
      throw error;
    }
  }
  async expireActorCredentials() {
    const credentials = await this.ctx.storage.list<{ expiresAt: number }>({
      prefix: "credential:",
    });
    for (const [key, value] of credentials) {
      // biome-ignore lint/performance/noAwaitInLoops: Fixture expires persisted credentials in order.
      await this.ctx.storage.put(key, {
        ...value,
        expiresAt: Date.now() - 16 * 60_000,
      });
    }
    return credentials.size;
  }
  storageLimits() {
    return this.ctx.storage.sql
      .exec<{ largest: number }>(
        "SELECT coalesce(max(length(CAST(value AS BLOB))),0) AS largest FROM room_meta"
      )
      .one();
  }
  async diagnostics() {
    return {
      alarm: await this.ctx.storage.getAlarm(),
      alarmError: await this.ctx.storage.get("fixtureAlarmError"),
      lastAlarm: await this.ctx.storage.get("fixtureAlarm"),
      sockets: this.ctx.getWebSockets().map((socket) => {
        const a = socket.deserializeAttachment();
        return {
          expires: a.expires,
          participantId: a.participantId,
          role: a.role,
        };
      }),
    };
  }
}

const app = new Hono<AppEnv>();
mountArtifactContentRoutes(app, {
  bucket: (env) => env.FILES,
  viewKey: (env) => env.ARTIFACT_VIEW_KEY,
  workspaceId: (claims) => claims.workspaceId,
});
app.route("/", liveRoomRoutes());
app.use("*", async (c, next) => {
  c.set("composed", compose(c.env, false));
  await next();
});
app.route("/", liveImageRoutes());
app.route(
  "/mcp",
  mcpRoutes({
    clientName: () => async () => null,
    dev: true,
    isOrgMember: () => async () => false,
    userOrgIds: () => async () => [],
    verifyOAuthToken: () => async () => null,
  })
);
app.get("/fixture/policy/:id", async (c) => {
  const composed = c.get("composed");
  const principal = await authenticateRoomRequest(c.env, composed, c.req.raw);
  if (!principal) {
    return c.text("Unauthorized", 401);
  }
  return c.json(
    await requiredLive(composed.services).ownBlobUrls(principal, {
      artifactId: c.req.param("id"),
    })
  );
});
app.post("/fixture/convert/:id", async (c) => {
  const member = {
    isAdmin: false,
    kind: "user" as const,
    userId: "u1",
    via: "session" as const,
    workspaceId: "w1",
  };
  const live = requiredLive(c.get("composed").services);
  const result = await live.convertDoc(member, {
    artifactId: c.req.param("id"),
  });
  return c.json({
    ...result,
    policy: await live.ownBlobUrls(member, { artifactId: result.artifactId }),
  });
});
// Fixed fixture run a1/r1: a guarded edit that carries an external image, in either mode.
app.post("/fixture/image-edit/:id", async (c) => {
  const { services } = c.get("composed");
  if (!services.liveRoom) {
    throw new Error("Missing room");
  }
  const input = await c.req.json<{
    changeId: string;
    markdown: string;
    mode: "direct" | "suggestion";
    scoped?: boolean;
  }>();
  const principal = {
    agentId: "a1",
    kind: "run" as const,
    runId: "r1",
    workspaceId: "w1",
  };
  const room = await services.liveRoom(principal, c.req.param("id"));
  if (input.scoped) {
    // The room already knows this actor; its run becomes guest-scoped afterwards.
    await c.env.DB.prepare("UPDATE runs SET scope_artifact_id=? WHERE id='r1'")
      .bind(c.req.param("id"))
      .run();
  }
  try {
    return c.json(
      await room.documentEdit(
        [{ content: { markdown: input.markdown }, op: "insert" }],
        {
          changeId: input.changeId,
          mode: input.mode,
          participantId: "a:a1:r1",
          runId: "r1",
          toolCallId: input.changeId,
        },
        "Image edit fixture"
      )
    );
  } finally {
    await c.env.DB.prepare(
      "UPDATE runs SET scope_artifact_id=NULL WHERE id='r1'"
    ).run();
  }
});
app.get("/fixture/suggestions/:id", async (c) =>
  c.json(
    await requiredLive(c.get("composed").services).suggestions(
      { agentId: "a1", kind: "run", runId: "r1", workspaceId: "w1" },
      { artifactId: c.req.param("id") }
    )
  )
);
app.post("/fixture/import-image/:id", async (c) =>
  c.json(
    await requiredLive(c.get("composed").services).importImage(
      {
        isAdmin: false,
        kind: "user",
        userId: "u1",
        via: "session",
        workspaceId: "w1",
      },
      {
        artifactId: c.req.param("id"),
        url: (await c.req.json<{ url: string }>()).url,
      }
    )
  )
);
app.get("/fixture/embed-sources/:id", async (c) =>
  c.json(
    await requiredLive(c.get("composed").services).embedSources(
      {
        isAdmin: false,
        kind: "user",
        userId: "u1",
        via: "session",
        workspaceId: "w1",
      },
      {
        artifactId: c.req.param("id"),
        cursor: c.req.query("cursor"),
        limit: 500,
      }
    )
  )
);
app.post("/fixture/embed/:id", async (c) => {
  const input = await c.req.json<{ source: string }>();
  return c.json(
    await requiredLive(c.get("composed").services).resolveEmbed(
      {
        isAdmin: false,
        kind: "user",
        userId: "u1",
        via: "session",
        workspaceId: "w1",
      },
      { artifactId: c.req.param("id"), source: input.source }
    )
  );
});
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
app.post("/fixture/ensure-cell/:id", async (c) => {
  const composed = c.get("composed");
  const principal = await authenticateRoomRequest(c.env, composed, c.req.raw);
  if (!principal) {
    return c.text("Unauthorized", 401);
  }
  const input = await c.req.json<{
    slideId: string;
    elementId: string;
    key: string;
  }>();
  return c.json(
    await requiredLive(composed.services).ensureDeckCell(principal, {
      ...input,
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

app.get("/fixture/diagnostics/:id", async (c) => {
  const namespace = c.env
    .ARTIFACT_ROOM as unknown as DurableObjectNamespace<ArtifactRoom>;
  const scope = { artifactId: c.req.param("id"), workspaceId: "w1" };
  const stub = namespace.getByName(
    JSON.stringify([scope.workspaceId, scope.artifactId])
  );
  return c.json(await stub.diagnostics());
});

app.post("/fixture/large", async (c) => {
  const composed = c.get("composed");
  const principal = await authenticateRoomRequest(c.env, composed, c.req.raw);
  if (!principal) {
    return c.text("Unauthorized", 401);
  }
  const created = await requiredLive(composed.services).createDocument(
    principal,
    { markdown: "x".repeat(5_000_000), title: "Large persisted document" }
  );
  const room = await composed.services.liveRoom?.(
    principal,
    created.artifactId
  );
  if (!room) {
    return c.text("Unavailable", 503);
  }
  const outline = await room.documentRead({});
  const namespace = c.env
    .ARTIFACT_ROOM as unknown as DurableObjectNamespace<ArtifactRoom>;
  const typed = namespace.getByName(JSON.stringify(["w1", created.artifactId]));
  return c.json({
    artifactId: created.artifactId,
    chars: outline.blocks[0]?.text.length,
    limits: await typed.storageLimits(),
  });
});

app.post("/fixture/expire-credentials/:id", async (c) => {
  const namespace = c.env
    .ARTIFACT_ROOM as unknown as DurableObjectNamespace<ArtifactRoom>;
  return c.json(
    await namespace
      .getByName(JSON.stringify(["w1", c.req.param("id")]))
      .expireActorCredentials()
  );
});
