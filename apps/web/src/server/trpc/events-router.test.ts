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

const newComposed = (): Composed =>
  composeWith({
    allowedOrgIds: ALLOWED_ORG_IDS,
    db,
    infra: infra(),
  });

const callerFor = async (
  session: { orgId?: string | null; userId: string | null },
  composed: Composed = newComposed()
) => appRouter.createCaller(await buildContext({ composed, session }));

const startAgent = async (caller: Awaited<ReturnType<typeof callerFor>>) =>
  caller.agents.create({ model: "fake", name: "Pelican", runtime: "fake" });

test("the log lists a run's events with links and leaves out another user's chat", async () => {
  const composed = newComposed();
  const owner = await callerFor({ orgId: "org_a", userId: "user_1" }, composed);
  const colleague = await callerFor(
    { orgId: "org_a", userId: "user_2" },
    composed
  );
  const agent = await startAgent(owner);
  const chat = await owner.runs.start({
    agentId: agent.id,
    input: { text: "private chat" },
    session: { origin: "ui" },
  });

  const mine = await owner.events.list({ agentId: agent.id });
  expect(mine.entries.length).toBeGreaterThan(0);
  expect(mine.entries.every((entry) => entry.agentId === agent.id)).toBe(true);
  expect(
    mine.entries.some(
      (entry) =>
        entry.type === "message.user" &&
        entry.sessionId === chat.sessionId &&
        entry.runId === chat.runId &&
        entry.summary === "private chat"
    )
  ).toBe(true);

  const theirs = await colleague.events.list({ agentId: agent.id });
  expect(theirs.entries.some((entry) => entry.sessionId !== null)).toBe(false);
  // Events outside any session stay visible to the whole workspace.
  expect(theirs.entries.map((entry) => entry.type)).toContain("agent.created");
});

test("the log filters by type and pages", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await startAgent(caller);
  await caller.runs.start({
    agentId: agent.id,
    input: { text: "hello" },
    session: { origin: "ui" },
  });

  const messages = await caller.events.list({ types: ["message.user"] });
  expect(messages.entries.map((entry) => entry.type)).toEqual(["message.user"]);

  const all = await caller.events.list({});
  const pageOne = await caller.events.list({ limit: 1 });
  const pageTwo = await caller.events.list({ limit: 1, page: 1 });
  expect(pageOne.hasMore).toBe(all.entries.length > 1);
  expect(pageOne.entries[0]?.id).toBe(all.entries[0]?.id);
  expect(pageTwo.entries[0]?.id).toBe(all.entries[1]?.id);
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(caller.events.list({})).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});
