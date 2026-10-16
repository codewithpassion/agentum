import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ALLOWED_ORG_IDS = ["org_a"];

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated();
});

const infra = (): Infra => {
  const store = new Map<string, string>();
  return {
    atomic: sqliteAtomic(db),
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    clock: systemClock,
    devFakeRuntime: true,
    fileBlobs: memoryFileBlobs(),
    relay: noopRelay,
  };
};

const callerFor = async (
  session: { orgId?: string | null; userId: string | null },
  composed: Composed = composeWith({
    allowedOrgIds: ALLOWED_ORG_IDS,
    db,
    infra: infra(),
  })
) => appRouter.createCaller(await buildContext({ composed, session }));

const setup = async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });
  return { agent, caller };
};

test("a plain ui start still works", async () => {
  const { agent, caller } = await setup();

  const started = await caller.runs.start({
    agentId: agent.id,
    input: { text: "hello" },
    session: { origin: "ui" },
  });

  expect(started.sessionId).toBeString();
  const run = await caller.runs.get({ runId: started.runId });
  expect(run.status).toBe("done");
});

test("a ui start can continue a session by its external key", async () => {
  const { agent, caller } = await setup();
  const first = await caller.runs.start({
    agentId: agent.id,
    input: { text: "one" },
    session: { origin: "ui" },
  });
  const transcript = await caller.sessions.transcript({
    sessionId: first.sessionId,
  });

  const second = await caller.runs.start({
    agentId: agent.id,
    input: { text: "two" },
    session: {
      externalKey: transcript.session.externalKey ?? first.sessionId,
      origin: "ui",
    },
  });

  expect(second.sessionId).toBe(first.sessionId);
});

test("a browser caller cannot pick a non-ui origin", async () => {
  const { agent, caller } = await setup();

  const attempts = ["slack", "inbox", "routine", "trigger", "mcp"].map(
    (origin) =>
      caller.runs.start({
        agentId: agent.id,
        input: { text: "hello" },
        // The wrong origin is the point of the test, so the type is bypassed.
        session: { externalKey: "T1:C1:123.456", origin } as never,
      })
  );

  for (const result of await Promise.allSettled(attempts)) {
    expect(result).toMatchObject({
      reason: { code: "BAD_REQUEST" },
      status: "rejected",
    });
  }
  expect(await caller.sessions.list({ agentId: agent.id })).toEqual([]);
});

test("a browser caller cannot make a session private", async () => {
  const { agent, caller } = await setup();

  await expect(
    caller.runs.start({
      agentId: agent.id,
      input: { text: "hello" },
      session: { origin: "ui", private: true } as never,
    })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await caller.sessions.list({ agentId: agent.id })).toEqual([]);
});

test("a browser caller cannot set a reply target", async () => {
  const { agent, caller } = await setup();

  await expect(
    caller.runs.start({
      agentId: agent.id,
      input: { text: "hello" },
      reply: { kind: "inbox", threadId: "thread_1" },
      session: { origin: "ui" },
    } as never)
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await caller.sessions.list({ agentId: agent.id })).toEqual([]);
});
