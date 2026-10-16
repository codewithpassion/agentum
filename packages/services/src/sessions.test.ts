import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { createEventsService } from "./events.ts";
import type { Clock } from "./runs/types.ts";
import { createRunsService, type RunsService } from "./runs.ts";
import { createSessionsService, type SessionsService } from "./sessions.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";

const user = (userId: string, workspaceId = WORKSPACE): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});

const runAs = (runId: string, agent: string): Principal => ({
  agentId: agent,
  kind: "run",
  runId,
  workspaceId: WORKSPACE,
});

type Db = ReturnType<typeof migrated>;

let db: Db;
let nowMs: number;
let agents: AgentsService;
let runs: RunsService;
let sessions: SessionsService;
let agentId: string;
let otherAgentId: string;

const insertWorkspace = (id: string) =>
  db
    .insert(workspaceRows)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: START,
      id,
      name: id,
      timezone: "UTC",
    })
    .run();

const startIn = (
  principal: Principal,
  agent: string,
  text: string,
  session: { externalKey?: string; origin: "ui" | "slack" }
) =>
  runs.startRun(principal, {
    agentId: agent,
    input: { text },
    session,
  });

const send = (principal: Principal, text: string, externalKey?: string) =>
  startIn(principal, agentId, text, { externalKey, origin: "ui" });

beforeEach(async () => {
  db = migrated();
  nowMs = Date.parse(START);
  // Each call to now() moves one second, so runs and sessions sort by creation.
  const clock: Clock = {
    now: () => {
      nowMs += 1000;
      return new Date(nowMs);
    },
    sleep: () => Promise.resolve(),
  };
  const store = new Map<string, string>();
  const blobs = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, body: string) => {
      store.set(key, body);
      return Promise.resolve();
    },
  };
  const events = createEventsService({ blobs, db });
  agents = createAgentsService({ db, events });
  insertWorkspace(WORKSPACE);
  insertWorkspace("w2");
  agentId = (
    await agents.create(user("u1"), {
      model: "m",
      name: "Fake",
      runtime: "fake",
    })
  ).id;
  otherAgentId = (
    await agents.create(user("u1"), {
      model: "m",
      name: "Other",
      runtime: "fake",
    })
  ).id;
  runs = createRunsService({
    adapters: [],
    atomic: sqliteAtomic(db),
    blobs,
    clock,
    db,
    devFakeRuntime: true,
    gateways: [],
  });
  sessions = createSessionsService({ db, events });
});

test("list shows the caller's sessions newest first, with title and status", async () => {
  const first = await send(user("u1"), "first question");
  const second = await send(user("u1"), "second question");

  const items = await sessions.list(user("u1"), { agentId });

  expect(items.map((item) => item.id)).toEqual([
    second.sessionId,
    first.sessionId,
  ]);
  expect(items[0]).toMatchObject({
    origin: "ui",
    status: "done",
    title: "second question",
  });
});

test("list takes the title from the first message and the status from the last run", async () => {
  const first = await send(user("u1"), "opening");
  const next = await send(user("u1"), "follow up", first.sessionId);
  db.update(runRows)
    .set({ status: "interrupted" })
    .where(eq(runRows.id, next.runId))
    .run();

  const [item] = await sessions.list(user("u1"), { agentId });

  expect(item).toMatchObject({ status: "interrupted", title: "opening" });
});

test("list hides another user's ui session and other workspaces' sessions", async () => {
  await send(user("u1"), "private");

  expect(await sessions.list(user("u2"), { agentId })).toEqual([]);
  expect(await sessions.list(user("u1", "w2"), { agentId })).toEqual([]);
});

test("transcript returns the messages and the latest run with its input text", async () => {
  const first = await send(user("u1"), "hello");
  await send(user("u1"), "again", first.sessionId);

  const result = await sessions.transcript(user("u1"), first.sessionId);

  expect(result.entries.map((entry) => entry.type)).toEqual([
    "message.user",
    "message.assistant",
    "message.user",
    "message.assistant",
  ]);
  expect(result.latestRun).toMatchObject({
    inputText: "again",
    resultText: "Echo: again",
    status: "done",
  });
  expect(result.session).toMatchObject({ agentId, id: first.sessionId });
});

test("transcript lists the output files of every run that has any", async () => {
  const first = await send(user("u1"), "hello");
  const second = await send(user("u1"), "again", first.sessionId);
  const third = await send(user("u1"), "no files", first.sessionId);
  db.update(runRows)
    .set({ outputFileIds: JSON.stringify(["file-a"]) })
    .where(eq(runRows.id, first.runId))
    .run();
  db.update(runRows)
    .set({ outputFileIds: JSON.stringify(["file-b"]) })
    .where(eq(runRows.id, second.runId))
    .run();

  const result = await sessions.transcript(user("u1"), first.sessionId);

  expect(result.outputFileIds).toEqual({
    [first.runId]: ["file-a"],
    [second.runId]: ["file-b"],
  });
  expect(result.outputFileIds).not.toHaveProperty(third.runId);
  expect(result.latestRun).toMatchObject({ id: third.runId });
});

test("transcript refuses a session of another user or another workspace", async () => {
  const started = await send(user("u1"), "hello");

  const errors = await Promise.all(
    [user("u2"), user("u1", "w2")].map((outsider) =>
      sessions
        .transcript(outsider, started.sessionId)
        .catch((caught: unknown) => caught)
    )
  );

  for (const error of errors) {
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "not_found" });
  }
});

test("the system principal cannot read sessions", async () => {
  const error = await sessions
    .list({ kind: "system" }, { agentId })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ForbiddenError);
});

test("a run lists its own agent's sessions and none of another agent's", async () => {
  const mine = await send(user("u1"), "mine");
  const principal = runAs(mine.runId, agentId);

  const own = await sessions.list(principal, { agentId });
  const other = await sessions.list(principal, { agentId: otherAgentId });

  expect(own.map((item) => item.id)).toEqual([mine.sessionId]);
  expect(other).toEqual([]);
});

test("a run sees the ui sessions of the user it runs for, not another user's", async () => {
  const mine = await send(user("u1"), "mine");
  const theirs = await send(user("u2"), "theirs");
  const shared = await startIn(user("u2"), agentId, "shared", {
    externalKey: "thread-1",
    origin: "slack",
  });
  const principal = runAs(mine.runId, agentId);

  const visible = await sessions.list(principal, { agentId });

  expect(visible.map((item) => item.id).sort()).toEqual(
    [mine.sessionId, shared.sessionId].sort()
  );
  expect(
    await sessions
      .transcript(principal, theirs.sessionId)
      .catch((caught: unknown) => caught)
  ).toMatchObject({ code: "not_found" });
});

test("a run with no user behind it, or a missing run, sees no ui session", async () => {
  const mine = await send(user("u1"), "mine");
  const shared = await startIn(user("u2"), agentId, "shared", {
    externalKey: "thread-1",
    origin: "slack",
  });
  db.update(runRows)
    .set({ onBehalfOfUserId: null })
    .where(eq(runRows.id, mine.runId))
    .run();

  const orphan = await sessions.list(runAs(mine.runId, agentId), { agentId });
  const missing = await sessions.list(runAs("no-such-run", agentId), {
    agentId,
  });

  expect(orphan.map((item) => item.id)).toEqual([shared.sessionId]);
  expect(missing.map((item) => item.id)).toEqual([shared.sessionId]);
});

test("a run cannot read a session of another agent", async () => {
  const mine = await send(user("u1"), "mine");
  const elsewhere = await startIn(user("u1"), otherAgentId, "elsewhere", {
    origin: "ui",
  });

  const error = await sessions
    .transcript(runAs(mine.runId, agentId), elsewhere.sessionId)
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ServiceError);
  expect(error).toMatchObject({
    code: "not_found",
    message: "Session not found",
  });
});

test("search finds a message by a case-insensitive substring", async () => {
  const started = await send(user("u1"), "The quick brown fox");
  await send(user("u1"), "unrelated words");

  const found = await sessions.search(user("u1"), {
    agentId,
    query: "BROWN",
  });

  expect(found.map((hit) => hit.session)).toMatchObject([
    { id: started.sessionId, status: "done", title: "The quick brown fox" },
  ]);
  const passages = found.flatMap((hit) => hit.passages);
  expect(passages.length).toBeGreaterThan(0);
  for (const passage of passages) {
    expect(passage.toLowerCase()).toContain("brown");
  }
});

test("search only looks at the agent it is asked about", async () => {
  await send(user("u1"), "needle here");
  await startIn(user("u1"), otherAgentId, "needle elsewhere", { origin: "ui" });

  const own = await sessions.search(user("u1"), { agentId, query: "needle" });
  const other = await sessions.search(user("u1"), {
    agentId: otherAgentId,
    query: "needle",
  });

  expect(own.map((hit) => hit.session.agentId)).toEqual([agentId]);
  expect(other.map((hit) => hit.session.agentId)).toEqual([otherAgentId]);
});

test("search matches % and _ in the query literally", async () => {
  const percent = await send(user("u1"), "up 100% today");
  await send(user("u1"), "up 1000 today");
  const underscore = await send(user("u1"), "file a_b here");
  await send(user("u1"), "file axb here");

  const byPercent = await sessions.search(user("u1"), {
    agentId,
    query: "100%",
  });
  const byUnderscore = await sessions.search(user("u1"), {
    agentId,
    query: "a_b",
  });

  expect(byPercent.map((hit) => hit.session.id)).toEqual([percent.sessionId]);
  expect(byUnderscore.map((hit) => hit.session.id)).toEqual([
    underscore.sessionId,
  ]);
});

test("search cuts a passage to a window around the match, with ellipses", async () => {
  const long = `${"a".repeat(300)} needle ${"b".repeat(300)}`;
  await send(user("u1"), long);

  const [hit] = await sessions.search(user("u1"), {
    agentId,
    query: "needle",
  });
  const passage = hit?.passages[0] ?? "";

  expect(passage).toContain("needle");
  expect(passage.startsWith("...")).toBe(true);
  expect(passage.endsWith("...")).toBe(true);
  expect(passage.length).toBeLessThanOrEqual(166);
});

test("a run searches only its own agent, and only the sessions it may see", async () => {
  const mine = await send(user("u1"), "shared word");
  await send(user("u2"), "shared word");
  await startIn(user("u1"), otherAgentId, "shared word", { origin: "ui" });
  const principal = runAs(mine.runId, agentId);

  const own = await sessions.search(principal, { agentId, query: "shared" });
  const other = await sessions.search(principal, {
    agentId: otherAgentId,
    query: "shared",
  });

  expect(own.map((hit) => hit.session.id)).toEqual([mine.sessionId]);
  expect(other).toEqual([]);
});

test("search rejects an empty or over-long query", async () => {
  const errors = await Promise.all(
    ["   ", "x".repeat(201)].map((query) =>
      sessions
        .search(user("u1"), { agentId, query })
        .catch((caught: unknown) => caught)
    )
  );
  for (const error of errors) {
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "invalid" });
  }
});
