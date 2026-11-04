import { expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import {
  artifactGrants,
  artifacts,
  artifactVersions,
} from "@repo/db/schema/artifacts";
import { events } from "@repo/db/schema/events";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { triggers } from "@repo/db/schema/triggers";
import { migrated } from "@repo/db/test-db";
import { noopRelay } from "@repo/services/machines/types";
import { createRunsService } from "@repo/services/runs";
import { systemClock } from "@repo/services/runs/types";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import { composeWith, type Infra } from "../compose.ts";
import { createAppHost } from "./app-host-core.ts";
import { fakePorts } from "./fakes.ts";
import type { AppHostProps, AppReplyMessage } from "./types.ts";

const setup = async (
  fake = true,
  throws = false,
  missingExports = false,
  overrides: Partial<Infra> = {}
) => {
  const db = migrated(["org_a"]);
  const replies: { host: AppHostProps; message: AppReplyMessage }[] = [];
  const storage = fakePorts();
  const infra: Infra = {
    appErrorSlot: async () => ({ dropped: 0 }),
    appReply: missingExports
      ? undefined
      : async (replyHost, message) => {
          if (throws) {
            throw new Error("boom");
          }
          replies.push({ host: replyHost, message });
          await createAppHost(replyHost, storage).setItem(
            "shared",
            "result",
            message.text
          );
        },
    atomic: sqliteAtomic(db),
    blobs: { get: async () => null, put: async () => undefined },
    clock: systemClock,
    cloudRunner: {
      cancel: async () => undefined,
      start: async () => undefined,
    },
    devFakeRuntime: fake,
    fileBlobs: {
      delete: async () => undefined,
      get: async () => null,
      put: async () => undefined,
    },
    publicBaseUrl: "https://example.com",
    relay: noopRelay,
    runTokenKey: Buffer.from(new Uint8Array(32)).toString("base64"),
    secretsKey: Buffer.from(new Uint8Array(32)).toString("base64"),
  };
  Object.assign(infra, overrides);
  const deferred: Promise<void>[] = [];
  infra.defer ??= (work) => {
    deferred.push(work);
  };
  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(deferred.splice(0));
  };
  const { services } = composeWith({ db, infra });
  const workspace = await services.workspaces.forOrg({ clerkOrgId: "org_a" });
  if (!workspace) {
    throw new Error("missing workspace");
  }
  const user = {
    kind: "user" as const,
    userId: "u1",
    via: "session" as const,
    workspaceId: workspace.id,
  };
  const agent = await services.agents.create(user, {
    model: "m",
    name: "Echo",
    runtime: fake ? "fake" : "cloud",
  });
  const now = new Date().toISOString();
  await db.insert(artifacts).values({
    audience: "workspace",
    createdAt: now,
    createdById: "u1",
    createdByKind: "user",
    currentVersionId: "v1",
    id: "app",
    kind: "app",
    ownerUserId: "u1",
    title: "App",
    updatedAt: now,
    workspaceId: workspace.id,
  });
  await db.insert(artifactVersions).values({
    artifactId: "app",
    authorId: "u1",
    authorKind: "user",
    createdAt: now,
    entry: "index.html",
    fileCount: 1,
    id: "v1",
    manifestKey: "m",
    message: "m",
    number: 1,
    status: "published",
    totalBytes: 1,
    workspaceId: workspace.id,
  });
  await db.insert(triggers).values({
    agentId: agent.id,
    artifactId: "app",
    createdAt: now,
    createdBy: "u1",
    id: "trigger",
    kind: "app",
    name: "App",
    workspaceId: workspace.id,
  });
  const props: AppHostProps = {
    artifactId: "app",
    meta: { ipPrefix: null, place: null, userAgent: null, visitorHash: "" },
    versionId: "v1",
    viewer: { endpointId: "ep", kind: "endpoint" },
    workspaceId: workspace.id,
  };
  const host = createAppHost(props, {
    ...storage,
    startRun: services.artifactApp.startRun,
  });
  const grant = () =>
    db.insert(artifactGrants).values({
      createdAt: now,
      id: "g",
      kind: "agent",
      status: "approved",
      target: agent.id,
      versionId: "v1",
      workspaceId: workspace.id,
    });
  return { agent, db, flush, grant, host, replies, services, storage, user };
};

test("endpoint hand-off requires a live approved grant and enabled trigger", async () => {
  const { db, host, grant, agent } = await setup();
  const input = { agent: agent.id, text: "hello" };
  await expect(host.startRun(input)).rejects.toThrow("not_granted");
  await grant();
  await db.update(triggers).set({ disabledAt: "paused" });
  await expect(host.startRun(input)).rejects.toThrow("forbidden");
  await db.update(triggers).set({ disabledAt: null });
  await db.update(artifacts).set({ currentVersionId: null });
  await expect(host.startRun(input)).rejects.toThrow("not_granted");
});

test("dev fake runtime hands off as nobody and replies into shared storage", async () => {
  const { db, host, grant, agent, replies, storage, flush } = await setup();
  await grant();
  const app = {
    async fetch(request: Request, env: { AGENTUM: typeof host }) {
      return Response.json(
        await env.AGENTUM.startRun({
          agent: agent.id,
          sessionKey: "channel",
          state: "token",
          text: await request.text(),
        })
      );
    },
  };
  const response = await app.fetch(
    new Request("https://app.test/incoming", { body: "hello", method: "POST" }),
    { AGENTUM: host }
  );
  const { runId } = (await response.json()) as { runId: string };
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  expect(run?.onBehalfOfUserId).toBeNull();
  expect(JSON.parse(run?.reply ?? "null")).toEqual({
    artifactId: "app",
    kind: "app",
    state: "token",
  });
  expect(await db.select().from(sessions)).toMatchObject([
    { externalKey: "app:trigger:channel", origin: "trigger" },
  ]);
  await flush();
  expect(replies).toMatchObject([
    {
      host: { viewer: { kind: "reply", runId } },
      message: {
        fileIds: [],
        runId,
        state: "token",
        status: "finished",
        text: "Echo: hello",
      },
    },
  ]);
  expect(
    await storage.store.get(
      { area: "shared", artifactId: "app", viewerKey: "" },
      "result"
    )
  ).toBe("Echo: hello");
});

test("a throwing reply records one app.reply_failed event without retry", async () => {
  const { db, host, grant, agent, flush } = await setup(true, true);
  await grant();
  await host.startRun({ agent: agent.id, text: "hello" });
  await flush();
  expect(
    (await db.select().from(events)).filter(
      (e) => e.type === "app.reply_failed"
    )
  ).toHaveLength(1);
  expect((await db.select().from(events)).filter((e) => e.type === "app.error").map((e) => JSON.parse(e.payload ?? "{}"))).toMatchObject([{ entry: "reply", message: "boom" }]);
});

test("failed runs deliver failed status through the runs event hook", async () => {
  const { host, grant, agent, services, replies, flush } = await setup(false);
  await grant();
  // Finish through the public run service so its event hook delivers the failure.
  const { runId } = await host.startRun({
    agent: agent.id,
    state: "failure-state",
    text: "hello",
  });
  await services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await services.runs.completeRun(SYSTEM_PRINCIPAL, runId, {
    error: "failed",
    status: "failed",
  });
  await flush();
  expect(replies).toMatchObject([
    { message: { state: "failure-state", status: "failed" } },
  ]);
});

test("missing Worker exports records app.reply_failed", async () => {
  const { db, host, grant, agent, flush } = await setup(true, false, true);
  await grant();
  await host.startRun({ agent: agent.id, text: "hello" });
  await flush();
  expect(
    (await db.select().from(events)).filter(
      (e) => e.type === "app.reply_failed"
    )
  ).toHaveLength(1);
});

for (const status of ["cancelled", "interrupted"] as const) {
  test(`${status} runs deliver their terminal status`, async () => {
    const { host, grant, agent, services, replies, flush } = await setup(false);
    await grant();
    const { runId } = await host.startRun({ agent: agent.id, text: "hello" });
    await services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
    if (status === "cancelled") {
      await services.runs.cancelRun(SYSTEM_PRINCIPAL, runId);
    } else {
      await services.runs.completeRun(SYSTEM_PRINCIPAL, runId, {
        status: "aborted",
      });
    }
    await flush();
    expect(replies).toMatchObject([{ message: { status } }]);
  });
}

test("deleting an app closes hand-off", async () => {
  const { db, host, grant, agent } = await setup();
  await grant();
  await db.update(artifacts).set({ deletedAt: new Date().toISOString() });
  await expect(
    host.startRun({ agent: agent.id, text: "hello" })
  ).rejects.toThrow("not_granted");
});

test("delivery resolves the current version rather than the run's starting version", async () => {
  const { db, host, grant, agent, services, replies, flush } =
    await setup(false);
  await grant();
  const { runId } = await host.startRun({ agent: agent.id, text: "hello" });
  await db.update(artifacts).set({ currentVersionId: "v2" });
  await services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await services.runs.completeRun(SYSTEM_PRINCIPAL, runId, {
    status: "done",
    text: "reply",
  });
  await flush();
  expect(replies).toMatchObject([
    { host: { versionId: "v2" }, message: { text: "reply" } },
  ]);
});

test("state and session keys enforce their limits before starting a run", async () => {
  const { db, host, grant, agent } = await setup();
  await grant();
  await expect(
    host.startRun({ agent: agent.id, state: "s".repeat(4097), text: "hello" })
  ).rejects.toMatchObject({
    code: "invalid",
    message: "Invalid startRun input",
  });
  await expect(
    host.startRun({
      agent: agent.id,
      sessionKey: "k".repeat(171),
      text: "hello",
    })
  ).rejects.toMatchObject({
    code: "invalid",
    message: "Invalid startRun input",
  });
  expect(await db.select().from(runs)).toHaveLength(0);
});

test("two apps using the same session key get separate sessions", async () => {
  const { db, host, grant, agent, services, user, flush } = await setup();
  await grant();
  const [first] = await db.select().from(artifacts);
  const [version] = await db.select().from(artifactVersions);
  if (!(first && version)) {
    throw new Error("missing app");
  }
  await db
    .insert(artifacts)
    .values({ ...first, currentVersionId: "v2", id: "app2" });
  await db
    .insert(artifactVersions)
    .values({ ...version, artifactId: "app2", id: "v2" });
  await services.artifactGrants.recordVersionGrants(user, {
    artifactId: "app2",
    files: [
      { path: "server/index.js", text: "export default {}" },
      {
        path: "agentum.json",
        text: JSON.stringify({ agents: [{ agent: agent.id }] }),
      },
    ],
    versionId: "v2",
  });
  await host.startRun({
    agent: agent.id,
    sessionKey: "channel",
    text: "hello",
  });
  await services.artifactApp.startRun(
    { artifactId: "app2", versionId: "v2", workspaceId: user.workspaceId },
    { agent: agent.id, sessionKey: "channel", text: "hello" }
  );
  await flush();
  const rows = await db.select().from(sessions);
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.externalKey)).size).toBe(2);
});

for (const cancel of [false, true]) {
  test(`a never resolving reply does not delay ${cancel ? "cancel" : "completion"}`, async () => {
    const work: Promise<void>[] = [];
    let release!: () => void;
    const { host, grant, agent, services, flush } = await setup(
      false,
      false,
      false,
      {
        appReply: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        defer: (promise) => {
          work.push(promise);
        },
      }
    );
    await grant();
    const { runId } = await host.startRun({ agent: agent.id, text: "hello" });
    await services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
    try {
      const operation = cancel
        ? services.runs.cancelRun(SYSTEM_PRINCIPAL, runId)
        : services.runs.completeRun(SYSTEM_PRINCIPAL, runId, {
            status: "done",
            text: "done",
          });
      expect(
        await Promise.race([
          operation.then(() => "done"),
          new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
        ])
      ).toBe("done");
      await flush();
      expect(work.length).toBeGreaterThan(0);
    } finally {
      release?.();
      await Promise.all(work);
    }
  });
}

test("a throwing delivery lookup cannot fail completeRun", async () => {
  const { createAppReplies } = await import("@repo/services/artifacts/replies");
  const { db, host, grant, agent, services, flush } = await setup(false);
  await grant();
  const { runId } = await host.startRun({ agent: agent.id, text: "hello" });
  await services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
  let lookups = 0;
  const failingDb = new Proxy(db, {
    get(target, key) {
      if (key === "select") {
        return () => {
          lookups += 1;
          throw new Error("D1 unavailable");
        };
      }
      return Reflect.get(target, key);
    },
  });
  const replies = createAppReplies({ db: failingDb, events: services.events });
  const runService = createRunsService({
    adapters: [],
    atomic: sqliteAtomic(db),
    blobs: { get: async () => null, put: async () => undefined },
    clock: systemClock,
    db,
    devFakeRuntime: false,
    gateways: [replies.gateway],
  });
  await expect(
    runService.completeRun(SYSTEM_PRINCIPAL, runId, {
      status: "done",
      text: "done",
    })
  ).resolves.toBeUndefined();
  await flush();
  expect(lookups).toBe(1);
  expect(
    (await db.select().from(events)).filter(
      (e) => e.type === "app.reply_failed"
    )
  ).toMatchObject([{ payload: JSON.stringify({ artifactId: "app" }), runId }]);
});

test("app triggers refuse reassignment and repeated pauses preserve disabledAt", async () => {
  const { db, agent, services, user } = await setup(false);
  await expect(
    services.triggers.reassign(user, "trigger", agent.id)
  ).rejects.toThrow("App triggers cannot be reassigned");
  await db.update(triggers).set({ disabledAt: "original" });
  await services.triggers.setEnabled(user, {
    enabled: false,
    triggerId: "trigger",
  });
  expect((await db.select().from(triggers))[0]?.disabledAt).toBe("original");
});

test("a reply that exceeds 20 seconds records app.reply_failed", async () => {
  const { host, grant, agent, services, db, flush } = await setup(
    false,
    false,
    false,
    { appReply: () => new Promise(() => undefined) }
  );
  await grant();
  const { runId } = await host.startRun({ agent: agent.id, text: "hello" });
  await services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
  const original = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: () => void,
    ms: number
  ) => original(handler, ms === 20_000 ? 1 : ms)) as typeof setTimeout);
  try {
    await services.runs.completeRun(SYSTEM_PRINCIPAL, runId, {
      status: "done",
      text: "done",
    });
    await flush();
    expect(
      (await db.select().from(events)).filter(
        (event) => event.type === "app.reply_failed"
      )
    ).toHaveLength(1);
  } finally {
    timer.mockRestore();
  }
});

for (const stage of ["run", "artifact"] as const) {
  test(`the 20 second deadline includes a hung ${stage} lookup`, async () => {
    const { createAppReplies } = await import(
      "@repo/services/artifacts/replies"
    );
    const { db, host, grant, agent, services, user } = await setup(false);
    await grant();
    const { runId } = await host.startRun({ agent: agent.id, text: "hello" });
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    const work: Promise<void>[] = [];
    let lookups = 0;
    const hungDb = new Proxy(db, {
      get(target, key) {
        if (key === "select") {
          return () => ({
            from: () => ({
              where: () => ({
                limit: () => {
                  lookups += 1;
                  return stage === "artifact" && lookups === 1
                    ? Promise.resolve([run])
                    : new Promise(() => undefined);
                },
              }),
            }),
          });
        }
        return Reflect.get(target, key);
      },
    });
    const replies = createAppReplies({
      db: hungDb,
      defer: (pending) => {
        work.push(pending);
      },
      events: services.events,
      invoke: () => {
        throw new Error("must not invoke");
      },
    });
    const original = globalThis.setTimeout;
    const delays: number[] = [];
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      ms: number
    ) => {
      delays.push(ms);
      return original(handler, ms === 20_000 ? 1 : ms);
    }) as typeof setTimeout);
    try {
      await replies.gateway.deliver(
        { artifactId: "app", kind: "app", state: "secret" },
        { fileIds: [], text: "done" },
        {
          agentId: agent.id,
          onBehalfOfUserId: null,
          runId,
          ...{ sessionId: run?.sessionId, workspaceId: user.workspaceId },
        }
      );
      await Promise.race([
        Promise.all(work),
        new Promise((resolve) => original(resolve, 50)),
      ]);
      expect(delays).toContain(20_000);
      expect(
        (await db.select().from(events)).filter(
          (e) => e.type === "app.reply_failed"
        )
      ).toHaveLength(1);
    } finally {
      timer.mockRestore();
    }
  });
}

for (const failure of ["lookup", "json", "shape"] as const) {
  test(`terminal reply ${failure} failures are observable without leaking state`, async () => {
    const { createAppReplies } = await import(
      "@repo/services/artifacts/replies"
    );
    const { db, host, grant, agent, services, user } = await setup(false);
    await grant();
    const { runId } = await host.startRun({ agent: agent.id, text: "hello" });
    await db
      .update(runs)
      .set({
        reply:
          failure === "shape"
            ? JSON.stringify({
                artifactId: "app",
                kind: "app",
                state: { secret: "credential" },
              })
            : "credential: invalid JSON",
      })
      .where(eq(runs.id, runId));
    const work: Promise<void>[] = [];
    const failingDb =
      failure === "lookup"
        ? new Proxy(db, {
            get(target, key) {
              if (key === "select") {
                return () => {
                  throw new Error("credential: D1 error");
                };
              }
              return Reflect.get(target, key);
            },
          })
        : db;
    const replies = createAppReplies({
      db: failingDb,
      defer: (p) => {
        work.push(p);
      },
      events: services.events,
    });
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await replies.onEvent({
        actor: { id: "system", kind: "system" },
        agentId: agent.id,
        createdAt: new Date().toISOString(),
        id: "terminal-event",
        payload: {},
        payloadRef: null,
        runId,
        seq: null,
        sessionId: null,
        type: "run.failed",
        workspaceId: user.workspaceId,
      });
      await Promise.all(work);
      if (failure === "shape") {
        expect(
          (await db.select().from(events)).filter(
            (e) => e.type === "app.reply_failed"
          )
        ).toHaveLength(1);
      } else {
        expect(log).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(log.mock.calls)).toContain(runId);
      }
      expect(JSON.stringify(log.mock.calls)).not.toContain("credential");
    } finally {
      log.mockRestore();
    }
  });
}

test("a terminal event whose run disappeared leaves an ids-only failure trace", async () => {
  const { createAppReplies } = await import("@repo/services/artifacts/replies");
  const { db, services, user, agent } = await setup(false);
  const work: Promise<void>[] = [];
  const replies = createAppReplies({
    db,
    defer: (p) => {
      work.push(p);
    },
    events: services.events,
  });
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await replies.onEvent({
      actor: { id: "system", kind: "system" },
      agentId: agent.id,
      createdAt: new Date().toISOString(),
      id: "gone",
      payload: {},
      payloadRef: null,
      runId: "missing-run",
      seq: null,
      sessionId: null,
      type: "run.failed",
      workspaceId: user.workspaceId,
    });
    await Promise.all(work);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).toContain("missing-run");
  } finally {
    log.mockRestore();
  }
});
