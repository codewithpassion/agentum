import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
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

test("a chat on a fake agent shows in the session list and the transcript", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });

  const started = await caller.runs.start({
    agentId: agent.id,
    input: { text: "hello" },
    session: { origin: "ui" },
  });

  const [item] = await caller.sessions.list({ agentId: agent.id });
  expect(item).toMatchObject({ id: started.sessionId, title: "hello" });
  const transcript = await caller.sessions.transcript({
    sessionId: started.sessionId,
  });
  expect(transcript.entries.map((entry) => entry.type)).toEqual([
    "message.user",
    "message.assistant",
  ]);
  expect(transcript.latestRun?.status).toBe("done");
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(caller.sessions.list({ agentId: "x" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.sessions.transcript({ sessionId: "x" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("an unknown session is NOT_FOUND", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(
    caller.sessions.transcript({ sessionId: "missing" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
