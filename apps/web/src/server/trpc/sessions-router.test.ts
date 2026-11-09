import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ORG_IDS = ["org_a"];

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated(ORG_IDS);
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
    db,
    infra: infra(),
  });

const callerFor = async (
  session: { orgId?: string | null; userId: string | null },
  composed: Composed = newComposed()
) => appRouter.createCaller(await buildContext({ composed, session }));

/**
 * Starts a run as a user without going through the browser schema, which
 * accepts only `ui` sessions. Slack, the inbox and routines start runs the same way.
 */
const startOutsideBrowser = async (
  composed: Composed,
  userId: string,
  input: Parameters<Composed["services"]["runs"]["startRun"]>[1]
) => {
  const principal = await composed.services.workspaces.sessionPrincipal({
    orgId: "org_a",
    userId,
  });
  if (!principal) {
    throw new Error("user_1 has no workspace principal");
  }
  return composed.services.runs.startRun(principal, input);
};

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

test("a list without an agent returns sessions of every agent, newest first", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const first = await caller.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });
  const second = await caller.agents.create({
    model: "fake",
    name: "Heron",
    runtime: "fake",
  });

  await caller.runs.start({
    agentId: first.id,
    input: { text: "first" },
    session: { origin: "ui" },
  });
  // Session ids sort by creation time to the millisecond, so keep the two apart.
  await systemClock.sleep(5);
  await caller.runs.start({
    agentId: second.id,
    input: { text: "second" },
    session: { origin: "ui" },
  });

  const items = await caller.sessions.list({});
  expect(items.map((item) => item.agentId)).toEqual([second.id, first.id]);
  expect(items.map((item) => item.title)).toEqual(["second", "first"]);
});

test("the origin filter returns only sessions with that origin", async () => {
  const composed = newComposed();
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );
  const agent = await caller.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });

  await caller.runs.start({
    agentId: agent.id,
    input: { text: "typed" },
    session: { origin: "ui" },
  });
  // The browser schema refuses a "trigger" origin, so this run starts in-process
  // with "routine", the way a routine does.
  const routine = await startOutsideBrowser(composed, "user_1", {
    agentId: agent.id,
    input: { text: "nightly" },
    session: { origin: "routine" },
  });

  const items = await caller.sessions.list({ origin: "routine" });
  expect(items.map((item) => item.id)).toEqual([routine.sessionId]);
  expect(items[0]?.origin).toBe("routine");
});

test("the origin filter refuses dry_run, which only the agent builder sets", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(
    caller.sessions.list({ origin: "dry_run" as never })
  ).rejects.toThrow();
});

test("a user sees the shared sessions of a colleague but not their UI chats", async () => {
  const composed = newComposed();
  const owner = await callerFor({ orgId: "org_a", userId: "user_1" }, composed);
  const colleague = await callerFor(
    { orgId: "org_a", userId: "user_2" },
    composed
  );
  const agent = await owner.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });

  const chat = await owner.runs.start({
    agentId: agent.id,
    input: { text: "private chat" },
    session: { origin: "ui" },
  });
  const shared = await startOutsideBrowser(composed, "user_1", {
    agentId: agent.id,
    input: { text: "shared note" },
    session: { origin: "routine" },
  });

  const seenByColleague = await colleague.sessions.list({});
  expect(seenByColleague.map((item) => item.id)).toEqual([shared.sessionId]);

  const seenByOwner = await owner.sessions.list({});
  expect(seenByOwner.map((item) => item.id).sort()).toEqual(
    [chat.sessionId, shared.sessionId].sort()
  );
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(caller.sessions.list({ agentId: "x" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.sessions.list({})).rejects.toMatchObject({
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

test("main, rename, pin and archive work through the router, and a mail origin filter is accepted", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });

  const main = await caller.sessions.main({ agentId: agent.id });
  expect((await caller.sessions.main({ agentId: agent.id })).id).toBe(main.id);
  await caller.sessions.rename({ sessionId: main.id, title: "Home" });
  await caller.sessions.pin({ sessionId: main.id });
  const [listed] = await caller.sessions.list({ agentId: agent.id });
  expect(listed).toMatchObject({ title: "Home" });
  expect(listed?.pinnedAt).not.toBeNull();

  await caller.sessions.archive({ sessionId: main.id });
  expect(await caller.sessions.list({ agentId: agent.id })).toEqual([]);
  expect(
    (await caller.sessions.list({ agentId: agent.id, archived: true })).length
  ).toBe(1);
  await caller.sessions.unarchive({ sessionId: main.id });
  await caller.sessions.unpin({ sessionId: main.id });
  expect(await caller.sessions.list({ origin: "mail" })).toEqual([]);
});
