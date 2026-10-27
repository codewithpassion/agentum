// biome-ignore-all lint/performance/noBarrelFile: fixture Worker entry exports.
import { createDeckCheckpoint } from "@repo/mcp/tools/deck-scene";
import { createLiveGuestsService } from "@repo/services/live-guests/service";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { Hono } from "hono";
import { mountArtifactContentRoutes } from "../../artifact-content/routes";
import { compose } from "../../compose";
import type { AppEnv } from "../../routes/groups";
import { guestEmbeds } from "../guest-embeds";
import { guestEmailAdapter } from "../guest-infra";
import { guestRoutes } from "../guest-routes";
import { roomStub } from "../namespace";
import { requiredLive } from "../required";
import { liveImageRoutes, liveRoomRoutes } from "../routes";

export { SessionStream } from "../../session-stream";
export { LiveArtifactMaintenance } from "../maintenance";
export { ArtifactRoom } from "./production";

const mail: unknown[] = [];
const owner = {
  isAdmin: true,
  kind: "user" as const,
  userId: "u1",
  via: "session" as const,
  workspaceId: "w1",
};
const get = (env: Env) => {
  const composed = compose(env, false);
  composed.services.liveGuests = () =>
    createLiveGuestsService({
      ...composed,
      directory: { findMemberByEmail: () => Promise.resolve(null) },
      email: guestEmailAdapter(
        {
          send: (message) => {
            mail.push(message);
            return Promise.resolve({ messageId: "captured" });
          },
        },
        "noreply@example.com"
      ),
      events: composed.services.events,
      guestsOff: () =>
        Boolean((env as Env & { LIVE_GUESTS_OFF?: string }).LIVE_GUESTS_OFF),
      invalidations: {
        trigger: async () => {
          await env.LIVE_ARTIFACT_MAINTENANCE.getByName("maintenance").start();
          await requiredLive(composed.services).retryInvalidations({
            kind: "system",
          });
        },
      },
      inviterName: async () => "Inviter",
      origin: "https://localhost",
      pepper: new Uint8Array(32).fill(7),
    });
  return composed;
};
const guests = (composed: ReturnType<typeof get>) => {
  if (!composed.services.liveGuests) {
    throw new Error("Missing guest service");
  }
  return composed.services.liveGuests();
};
const app = new Hono<AppEnv>();
mountArtifactContentRoutes(app, {
  authorizeGuestEmbed: (claims, env) =>
    guestEmbeds(env, get(env)).authorize(claims),
  bucket: (env) => env.FILES,
  viewKey: (env) => env.ARTIFACT_VIEW_KEY,
  workspaceId: (claims) => claims.workspaceId,
});
app.route(
  "/",
  guestRoutes({
    compose: get,
    page: async () =>
      new Response(
        '<!doctype html><html lang="en"><head><link rel="stylesheet" href="/guest.css"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="guest-root"></div><script type="module" src="/guest.js"></script></body></html>',
        { headers: { "Content-Type": "text/html" } }
      ),
  })
);
app.route("/", liveRoomRoutes());
app.use("/api/live-artifacts/*", async (c, next) => {
  c.set("composed", get(c.env));
  await next();
});
app.route("/", liveImageRoutes());
app.post("/fixture/switch", async (c) => {
  const composed = get(c.env);
  return c.json(await (await guests(composed)).setEnabled(owner, false));
});
app.post("/fixture/create", async (c) => {
  const composed = get(c.env);
  const { role, email, artifactId, kind } = await c.req.json<{
    role: "viewer" | "commenter" | "editor";
    email: string;
    artifactId?: string;
    kind?: "document" | "deck";
  }>();
  let artifact: { artifactId: string };
  let embedSource: string | undefined;
  if (artifactId) {
    artifact = { artifactId };
  } else if (kind === "deck") {
    const page = await composed.services.artifacts.create(owner, {
      entry: "chart.html",
      files: [
        {
          path: "chart.html",
          text: "<!doctype html><html><body><h1>Guest scoped embed</h1></body></html>",
        },
      ],
      kind: "page",
      title: "Shared embed",
    });
    await composed.services.artifacts.setAudience(
      owner,
      page.artifactId,
      "workspace"
    );
    const file = await composed.services.artifacts.readFile(owner, {
      artifactId: page.artifactId,
      path: "chart.html",
    });
    embedSource = `artifact:${page.artifactId}:${page.versionId}:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(file.text)))].map((b) => b.toString(16).padStart(2, "0")).join("")}:chart.html`;
    const tableSlide =
      '<slide id="s1" order="a0" background="#fff" transition="none" duration="0"><element id="table" type="table" parent="s1" order="a0" prop-rows="2" prop-cols="2" prop-x="0" prop-y="0" prop-w="300" prop-h="200"></element></slide>';
    artifact = await requiredLive(composed.services).createDeck(owner, {
      slides: [tableSlide],
      title: "Guest deck",
    });
    const embeddedSlide = tableSlide.replace(
      "</slide>",
      `<element id="embed" type="embed" parent="s1" order="a1" prop-src="${embedSource}" prop-x="320" prop-y="0" prop-w="400" prop-h="240"></element></slide>`
    );
    // Seed an accepted checkpoint before the first room open; all later guest
    // reads use the actual production room and current grant checks.
    await requiredLive(composed.services).durableCheckpoint(
      SYSTEM_PRINCIPAL,
      {
        artifactId: artifact.artifactId,
        checkpointId: crypto.randomUUID(),
        origins: [],
        restores: [],
        revision: 1,
        state: createDeckCheckpoint(
          { slides: [embeddedSlide], title: "Guest deck" },
          (path) => path === embedSource
        ),
        workspaceId: owner.workspaceId,
      },
      owner
    );
  } else {
    artifact = await requiredLive(composed.services).createDocument(owner, {
      markdown: "# Hello\n\nShared text",
      title: "Guest document",
    });
  }
  const invitation = await (await guests(composed)).invite(owner, {
    artifactId: artifact.artifactId,
    email,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    role,
  });
  return c.json({ ...artifact, ...invitation, embedSource, mail });
});
app.get("/fixture/diagnostics/:id", async (c) => {
  const stub = await roomStub(c.env.ARTIFACT_ROOM, {
    artifactId: c.req.param("id"),
    workspaceId: "w1",
  });
  const fixture = stub as unknown as Pick<
    import("./production").ArtifactRoom,
    "diagnostics"
  >;
  return c.json(await fixture.diagnostics());
});
app.get("/fixture/mail", (c) => c.json(mail));
app.post("/fixture/checkpoint/:id", async (c) =>
  c.json(
    await (
      await roomStub(c.env.ARTIFACT_ROOM, {
        artifactId: c.req.param("id"),
        workspaceId: "w1",
      })
    ).checkpoint()
  )
);
// Test-only fixtures use fixed seeded principals and actual production room edit boundaries.
app.get("/fixture/accepted/:id", async (c) => {
  const room = await roomStub(c.env.ARTIFACT_ROOM, {
    artifactId: c.req.param("id"),
    workspaceId: "w1",
  });
  const snapshot = await room.authoritativeSnapshot();
  return c.json({ revision: snapshot.revision, state: [...snapshot.state] });
});
app.post("/fixture/review-proposal/:id", async (c) => {
  const artifactId = c.req.param("id");
  const { kind, key } = await c.req.json<{
    kind: "document" | "deck";
    key: string;
  }>();
  const { services } = get(c.env);
  if (!services.liveRoom) {
    throw new Error("Missing room");
  }
  const principal = {
    agentId: "review-agent",
    kind: "run" as const,
    runId: `review-run-${artifactId}`,
    workspaceId: "w1",
  };
  const room = await services.liveRoom(principal, artifactId);
  const origin = {
    changeId: `${artifactId}:${key}`,
    mode: "suggestion" as const,
    participantId: `a:review-agent:review-run-${artifactId}`,
    runId: principal.runId,
    toolCallId: key,
  };
  return c.json(
    kind === "document"
      ? await room.documentEdit(
          [{ content: { text: `Review ${key}` }, op: "insert" }],
          origin,
          "Browser review proposal"
        )
      : await room.deckWrite(
          {
            artifactId,
            ops: [
              {
                html: `<slide id="review-${key}" order="a1" background="#fff" transition="none" duration="0"><notes>Review ${key}</notes></slide>`,
                op: "add",
              },
            ],
          },
          origin
        )
  );
});
// Fixed fixture run, never mounted in production and never accepts caller identity.
app.post("/fixture/suggestion/:id", async (c) => {
  const { services } = get(c.env);
  if (!services.liveRoom) {
    throw new Error("Missing room");
  }
  const principal = {
    agentId: "thread-agent",
    kind: "run" as const,
    runId: "suggestion-run",
    workspaceId: "w1",
  };
  const room = await services.liveRoom(principal, c.req.param("id"));
  return c.json(
    await room.documentEdit(
      [{ content: { text: "Reviewed by a guest" }, op: "insert" }],
      {
        changeId: "guest-review",
        mode: "suggestion",
        participantId: "a:thread-agent:suggestion-run",
        runId: "suggestion-run",
        toolCallId: "guest-review",
      },
      "Guest review fixture"
    )
  );
});
app.post("/fixture/revoke/:artifact/:member", async (c) => {
  const composed = get(c.env);
  await (await guests(composed)).revoke(owner, {
    artifactId: c.req.param("artifact"),
    memberId: c.req.param("member"),
  });
  return c.json({ ok: true });
});
app.post("/fixture/role/:artifact/:member", async (c) => {
  const composed = get(c.env);
  await (await guests(composed)).changeRole(owner, {
    artifactId: c.req.param("artifact"),
    memberId: c.req.param("member"),
    role: "viewer",
  });
  return c.json({ ok: true });
});
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
};
