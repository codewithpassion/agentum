// biome-ignore-all lint/performance/noBarrelFile: local workerd fixture entrypoint only.
import { exports, waitUntil } from "cloudflare:workers";

import { createScopedGuestComments } from "@repo/services/live-guests/scoped-comments";
import { createLiveGuestsService } from "@repo/services/live-guests/service";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { Hono } from "hono";
import { type Composed, compose } from "../../compose";
import { GuestRun as ProductionGuestRun } from "../../guest-run";
import type {
  GuestExecutionState,
  GuestRunCoreDeps,
} from "../../guest-run-core";
import { guestRunRpc } from "../../guest-run-rpc";
import type { AppEnv } from "../../routes/groups";
import { guestEmailAdapter } from "../guest-infra";
import { guestRoutes } from "../guest-routes";
import { roomStub } from "../namespace";
import { requiredLive } from "../required";

export { SessionStream } from "../../session-stream";
export { LiveArtifactMaintenance } from "../maintenance";
export { ArtifactRoom } from "../production-room";

const mail: unknown[] = [];
const owner = {
  isAdmin: true,
  kind: "user" as const,
  userId: "u1",
  via: "session" as const,
  workspaceId: "w1",
};
const fixtureCompose = (env: Env): Composed => {
  const composed = compose(env, false, waitUntil, exports);
  // Explicit captured inference fixture only; no provider credentials/network.
  composed.services.managedKeys.resolve = () =>
    Promise.resolve({
      apiKey: "fixture-inference-has-no-provider",
      environmentId: null,
    });
  composed.services.modelKeys.resolve = () =>
    Promise.resolve({ apiKey: "fixture-inference-has-no-provider" });
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
      guestsOff: () => false,
      invalidations: {
        trigger: async () => {
          await env.LIVE_ARTIFACT_MAINTENANCE.getByName("maintenance").start();
          await composed.services.liveArtifacts?.retryInvalidations({
            kind: "system",
          });
        },
      },
      inviterName: () => Promise.resolve("Owner"),
      origin: "https://localhost",
      pepper: new Uint8Array(32).fill(7),
      runs: composed.services.runs,
    });
  return composed;
};
export class GuestRun extends ProductionGuestRun {
  #fixture?: Composed;
  protected override composed() {
    this.#fixture ??= fixtureCompose(this.env);
    return this.#fixture;
  }
  protected override async inference(
    input: Parameters<GuestRunCoreDeps["infer"]>[0]
  ) {
    const state = await this.ctx.storage.get<GuestExecutionState>("execution");
    await this.env.FILES.put(
      `fixture-inference/${state?.runId}/${input.history.length}`,
      JSON.stringify({
        ...input,
        context: await this.composed().services.runs.guestContext(
          SYSTEM_PRINCIPAL,
          state?.runId ?? ""
        ),
      })
    );
    const turn = JSON.parse(input.text).harbourmaster_turn as {
      text: string;
      via?: string;
      where?: { threadId?: string };
      artifact: { id: string; kind: string };
    };
    if (input.history.length) {
      return { kind: "answer", text: "Captured guest completion" };
    }
    if (turn.via === "comment") {
      return {
        input: {
          answered: true,
          artifactId: turn.artifact.id,
          body: "Scoped commenter reply",
          threadId: turn.where?.threadId,
        },
        kind: "tool",
        name:
          turn.artifact.kind === "deck" ? "deck_comment" : "document_comment",
      };
    }
    if (turn.text.includes("native")) {
      return {
        input: { artifactId: turn.artifact.id, command: "env" },
        kind: "tool",
        name: "bash",
      };
    }
    if (turn.text.includes("question")) {
      return { kind: "question", questions: [{ question: "May I continue?" }] };
    }
    if (turn.artifact.kind === "deck") {
      return {
        input: {
          artifactId: turn.artifact.id,
          ops: [
            {
              html: '<slide id="guest-proposed-slide" order="a1" background="#fff" transition="none" duration="0"></slide>',
              op: "add",
            },
          ],
        },
        kind: "tool",
        name: "deck_write",
      };
    }
    return {
      input: turn.text.includes("suggest")
        ? {
            artifactId: turn.artifact.id,
            ops: [{ content: { text: "Guest proposed text" }, op: "insert" }],
            summary: "Guest suggestion",
          }
        : { artifactId: turn.artifact.id },
      kind: "tool",
      name: turn.text.includes("suggest") ? "document_edit" : "document_read",
    };
  }
  async recoverEffect() {
    for (let i = 0; i < 4; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each crash-replay phase depends on the prior persisted state.
      const state = await this.diagnostics();
      const previous = state?.history[0];
      if (state && previous && state.history.length === 1) {
        await this.ctx.storage.put("execution", {
          ...state,
          history: [],
          pending: previous.call,
          phase: "effect",
          seq: 0,
          turn: 0,
        });
        await super.alarm();
        return this.diagnostics();
      }
      await super.alarm();
    }
    throw new Error("No persisted effect to replay");
  }
  diagnostics() {
    return this.ctx.storage.get<GuestExecutionState>("execution");
  }
  async advance() {
    await super.alarm();
    return this.diagnostics();
  }
}
const app = new Hono<AppEnv>();
app.route(
  "/",
  guestRoutes({
    compose: fixtureCompose,
    page: async () =>
      new Response(
        '<!doctype html><html lang="en"><head><link rel="stylesheet" href="/guest.css"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="guest-root"></div><script type="module" src="/guest.js"></script></body></html>',
        { headers: { "Content-Type": "text/html" } }
      ),
  })
);
app.get("/fixture/snapshot/:id", async (c) => {
  const snapshot = await (
    await roomStub(c.env.ARTIFACT_ROOM, {
      artifactId: c.req.param("id"),
      workspaceId: "w1",
    })
  ).authoritativeSnapshot();
  return c.json({ revision: snapshot.revision, state: [...snapshot.state] });
});
app.post("/fixture/role/:artifact/:member", async (c) => {
  await (await fixtureCompose(c.env).services.liveGuests?.())?.changeRole(
    owner,
    {
      artifactId: c.req.param("artifact"),
      memberId: c.req.param("member"),
      role: "viewer",
    }
  );
  return c.json({ ok: true });
});
app.post("/fixture/create", async (c) => {
  const composed = fixtureCompose(c.env);
  const input = await c.req.json<{
    artifactId?: string;
    kind?: string;
    email?: string;
    role?: "viewer" | "commenter" | "editor";
  }>();
  const live = requiredLive(composed.services);
  let artifact: { artifactId: string };
  if (input.artifactId) {
    artifact = { artifactId: input.artifactId };
  } else if (input.kind === "deck") {
    artifact = await live.createDeck(owner, {
      slides: [
        '<slide id="s1" order="a0" background="#fff" transition="none" duration="0"></slide>',
      ],
      title: "Executor deck",
    });
  } else {
    artifact = await live.createDocument(owner, {
      markdown: "# Accepted original",
      title: "Executor document",
    });
  }
  const guests = await composed.services.liveGuests?.();
  if (!guests) {
    throw new Error("Missing guests");
  }
  const invite = await guests.invite(owner, {
    agentRunsPerDay: 2,
    artifactId: artifact.artifactId,
    email:
      input.email ??
      (input.kind === "deck" ? "deck@example.com" : "guest@example.com"),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    role: input.role ?? "editor",
  });
  return c.json({ ...artifact, ...invite, mail });
});
app.get("/fixture/mail", (c) => c.json(mail));
app.get("/fixture/requests", async (c) =>
  c.json(await fixtureCompose(c.env).services.requests.listPending(owner))
);
app.post("/fixture/answer/:id", async (c) =>
  c.json(
    await fixtureCompose(c.env).services.requests.answer(owner, {
      answer: { decision: "allow_once" },
      requestId: c.req.param("id"),
      via: "web",
    })
  )
);
app.post("/fixture/advance/:id", async (c) =>
  c.json(
    await (
      c.env.GUEST_RUN.getByName(c.req.param("id")) as unknown as GuestRun
    ).advance()
  )
);
app.post("/fixture/probe/:id", async (c) => {
  const composed = fixtureCompose(c.env);
  const { run } = await composed.services.runs.guestExecution(
    SYSTEM_PRINCIPAL,
    c.req.param("id")
  );
  const principal = {
    agentId: run.agentId,
    kind: "run" as const,
    runId: run.id,
    scopeArtifactId: run.scopeArtifactId ?? undefined,
    workspaceId: run.workspaceId,
  };
  const live = requiredLive(composed.services);
  const rpc = guestRunRpc(c.env, composed);
  const results = await Promise.allSettled([
    rpc(
      run,
      "tools/call",
      { arguments: { command: "env" }, name: "bash" },
      "probe-native"
    ),
    rpc(
      run,
      "tools/call",
      {
        arguments: { artifactId: "00000000-0000-4000-8000-000000000001" },
        name: "document_read",
      },
      "probe-foreign"
    ),
    live.restore(principal, {
      artifactId: run.scopeArtifactId ?? "",
      version: 1,
    }),
    live.importImage(principal, {
      artifactId: run.scopeArtifactId ?? "",
      url: "https://images.unsplash.com/forbidden",
    }),
  ]);
  return c.json({
    refused: results.filter((result) => result.status === "rejected").length,
  });
});
app.post("/fixture/answer-preview/:id", async (c) => {
  const composed = fixtureCompose(c.env);
  const comments = createScopedGuestComments({
    ...composed,
    events: composed.services.events,
    guestsOff: () => false,
    runs: composed.services.runs,
  });
  await comments.answer(
    SYSTEM_PRINCIPAL,
    c.req.param("id"),
    "Captured guest completion"
  );
  await comments.answer(
    SYSTEM_PRINCIPAL,
    c.req.param("id"),
    "Captured guest completion"
  );
  return c.json({ ok: true });
});
app.post("/fixture/recover/:id", async (c) =>
  c.json(
    await (
      c.env.GUEST_RUN.getByName(c.req.param("id")) as unknown as GuestRun
    ).recoverEffect()
  )
);
app.get("/fixture/state/:id", async (c) =>
  c.json(
    await (
      c.env.GUEST_RUN.getByName(c.req.param("id")) as unknown as GuestRun
    ).diagnostics()
  )
);
export default app;
