import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { inboxThreads } from "@repo/db/schema/inbox";
import { machines as machineRows } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { triggers as triggerRows } from "@repo/db/schema/triggers";
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
  session: {
    externalKey?: string;
    origin: "ui" | "slack" | "inbox" | "trigger";
    private?: boolean;
  }
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

test("the title is the first message trimmed to 60 characters, in the list and the transcript", async () => {
  const long = `  ${"word ".repeat(30)}`;
  const started = await send(user("u1"), long);

  const [item] = await sessions.list(user("u1"), { agentId });
  const { session } = await sessions.transcript(user("u1"), started.sessionId);

  const expected = `${long.trim().slice(0, 60)}...`;
  expect(item?.title).toBe(expected);
  expect(session.title).toBe(expected);
});

const insertTrigger = (id: string, kind: "http" | "routine", name: string) =>
  db
    .insert(triggerRows)
    .values({
      agentId,
      createdAt: START,
      createdBy: "u1",
      id,
      kind,
      name,
      workspaceId: WORKSPACE,
    })
    .run();

const insertThread = (id: string, title: string) =>
  db
    .insert(inboxThreads)
    .values({
      createdAt: START,
      createdBy: "u1",
      id,
      lastPostAt: START,
      title,
      workspaceId: WORKSPACE,
    })
    .run();

const insertSlackName = (sessionId: string, eventId: string, label: string) =>
  db
    .insert(eventRows)
    .values({
      actorId: "slack",
      actorKind: "system",
      agentId,
      createdAt: START,
      id: eventId,
      payload: JSON.stringify({ label }),
      sessionId,
      type: "slack.named",
      workspaceId: WORKSPACE,
    })
    .run();

const triggerPrincipal = (triggerId: string): Principal => ({
  agentId,
  kind: "trigger",
  triggerId,
  workspaceId: WORKSPACE,
});

test("a trigger session is titled by the trigger's name, in the list and the transcript", async () => {
  insertTrigger("trg-deploy", "http", "Deploy hook");
  const started = await startIn(
    triggerPrincipal("trg-deploy"),
    agentId,
    "build the site",
    { origin: "trigger" }
  );

  const [item] = await sessions.list(user("u1"), { origin: "trigger" });
  const { session } = await sessions.transcript(user("u1"), started.sessionId);

  expect(item).toMatchObject({ id: started.sessionId, title: "Deploy hook" });
  expect(session.title).toBe("Deploy hook");
});

test("a routine session is titled by the routine's name", async () => {
  insertTrigger("trg-digest", "routine", "Daily digest");
  const started = await startIn(
    triggerPrincipal("trg-digest"),
    agentId,
    "summarise the day",
    { origin: "trigger" }
  );

  const [item] = await sessions.list(user("u1"), { origin: "trigger" });

  expect(item).toMatchObject({ id: started.sessionId, title: "Daily digest" });
});

test("a trigger with a blank name, or no row, is titled by the first message", async () => {
  insertTrigger("trg-blank", "http", "   ");
  const blank = await startIn(
    triggerPrincipal("trg-blank"),
    agentId,
    "blank name",
    {
      origin: "trigger",
    }
  );
  const gone = await startIn(
    triggerPrincipal("trg-gone"),
    agentId,
    "row deleted",
    {
      origin: "trigger",
    }
  );

  const items = await sessions.list(user("u1"), { origin: "trigger" });

  expect(items.find((item) => item.id === blank.sessionId)?.title).toBe(
    "blank name"
  );
  expect(items.find((item) => item.id === gone.sessionId)?.title).toBe(
    "row deleted"
  );
});

test("an inbox session is titled by its thread's title", async () => {
  insertThread("thr-1", "Quarterly review");
  const started = await startIn(user("u1"), agentId, "draft the agenda", {
    externalKey: "thr-1",
    origin: "inbox",
  });

  const [item] = await sessions.list(user("u1"), { origin: "inbox" });

  expect(item).toMatchObject({
    id: started.sessionId,
    title: "Quarterly review",
  });
});

test("an inbox session whose thread is gone is titled by the first message", async () => {
  const started = await startIn(user("u1"), agentId, "draft the agenda", {
    externalKey: "thr-missing",
    origin: "inbox",
  });

  const [item] = await sessions.list(user("u1"), { origin: "inbox" });

  expect(item).toMatchObject({
    id: started.sessionId,
    title: "draft the agenda",
  });
});

test("a Slack session is titled with its label and the first message", async () => {
  const started = await startIn(user("u1"), agentId, "Hello team", {
    externalKey: "thread-1",
    origin: "slack",
  });
  insertSlackName(started.sessionId, "01AAAAAAAAAAAAAAAAAAAAAAAA", "#old");
  insertSlackName(started.sessionId, "01BBBBBBBBBBBBBBBBBBBBBBBB", "#launch");

  const [item] = await sessions.list(user("u1"), { origin: "slack" });

  expect(item?.title).toBe("#launch: Hello team");
});

test("a Slack session with no label event is titled by the first message", async () => {
  await startIn(user("u1"), agentId, "Hello team", {
    externalKey: "thread-1",
    origin: "slack",
  });

  const [item] = await sessions.list(user("u1"), { origin: "slack" });

  expect(item?.title).toBe("Hello team");
});

test("a ui session ignores a Slack label event", async () => {
  const started = await send(user("u1"), "from the ui");
  insertSlackName(started.sessionId, "01CCCCCCCCCCCCCCCCCCCCCCCC", "#launch");

  const [item] = await sessions.list(user("u1"), { origin: "ui" });

  expect(item?.title).toBe("from the ui");
});

test("list hides another user's ui session and other workspaces' sessions", async () => {
  await send(user("u1"), "private");

  expect(await sessions.list(user("u2"), { agentId })).toEqual([]);
  expect(await sessions.list(user("u1", "w2"), { agentId })).toEqual([]);
});

test("list without agentId returns the sessions of every agent, newest first", async () => {
  const first = await send(user("u1"), "first agent");
  const second = await startIn(user("u1"), otherAgentId, "second agent", {
    origin: "ui",
  });

  const items = await sessions.list(user("u1"));

  expect(items.map((item) => item.id)).toEqual([
    second.sessionId,
    first.sessionId,
  ]);
  expect(items.map((item) => item.agentId)).toEqual([otherAgentId, agentId]);
});

test("list with agentId returns only that agent's sessions", async () => {
  const mine = await send(user("u1"), "mine");
  await startIn(user("u1"), otherAgentId, "elsewhere", { origin: "ui" });

  const items = await sessions.list(user("u1"), { agentId });

  expect(items.map((item) => item.id)).toEqual([mine.sessionId]);
});

test("list with origin returns only sessions of that origin", async () => {
  const ui = await send(user("u1"), "from the ui");
  const slack = await startIn(user("u1"), agentId, "from slack", {
    externalKey: "thread-1",
    origin: "slack",
  });

  const items = await sessions.list(user("u1"), { origin: "slack" });

  expect(items.map((item) => item.id)).toEqual([slack.sessionId]);
  expect(items.map((item) => item.id)).not.toContain(ui.sessionId);
});

test("list without agentId keeps another user's ui and private sessions out", async () => {
  const mine = await send(user("u1"), "mine");
  await send(user("u2"), "theirs in the ui");
  await startIn(user("u2"), otherAgentId, "theirs in a DM", {
    externalKey: "dm-1",
    origin: "slack",
    private: true,
  });

  const items = await sessions.list(user("u1"));

  expect(items.map((item) => item.id)).toEqual([mine.sessionId]);
});

test("get returns a visible session and hides another user's ui session, an unknown id and another workspace's", async () => {
  const mine = await send(user("u1"), "mine");
  const dm = await startIn(user("u1"), agentId, "dm", {
    origin: "slack",
    private: true,
  });

  expect(await sessions.get(user("u1"), mine.sessionId)).toMatchObject({
    id: mine.sessionId,
    origin: "ui",
  });
  await expect(sessions.get(user("u2"), mine.sessionId)).rejects.toThrow(
    "Session not found"
  );
  await expect(sessions.get(user("u2"), dm.sessionId)).rejects.toThrow(
    "Session not found"
  );
  await expect(sessions.get(user("u1"), "missing")).rejects.toThrow(
    "Session not found"
  );
  await expect(sessions.get(user("u1", "w2"), mine.sessionId)).rejects.toThrow(
    "Session not found"
  );
});

test("a private Slack DM record is marked private, a thread is not", async () => {
  const dm = await startIn(user("u1"), agentId, "dm text", {
    externalKey: "dm-1",
    origin: "slack",
    private: true,
  });
  const thread = await startIn(user("u1"), agentId, "thread text", {
    externalKey: "thread-1",
    origin: "slack",
  });

  const items = await sessions.list(user("u1"), { origin: "slack" });

  expect(items.find((item) => item.id === dm.sessionId)?.private).toBe(true);
  expect(items.find((item) => item.id === thread.sessionId)?.private).toBe(
    false
  );
  expect(
    (await sessions.transcript(user("u1"), dm.sessionId)).session.private
  ).toBe(true);
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
  // A Slack channel thread: not private, so every user sees it.
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

test("a private Slack DM is visible only to the user who started it, and to runs for that user", async () => {
  const mine = await send(user("u1"), "mine");
  const dm = await startIn(user("u2"), agentId, "dm text", {
    externalKey: "dm-1",
    origin: "slack",
    private: true,
  });
  const thread = await startIn(user("u2"), agentId, "thread text", {
    externalKey: "thread-1",
    origin: "slack",
  });
  const principal = runAs(mine.runId, agentId);
  const listIds = async (reader: Principal) =>
    (await sessions.list(reader, { agentId })).map((item) => item.id).sort();
  const hidden = (reader: Principal) =>
    sessions
      .transcript(reader, dm.sessionId)
      .catch((caught: unknown) => caught);

  expect(await listIds(user("u1"))).toEqual(
    [mine.sessionId, thread.sessionId].sort()
  );
  expect(await listIds(principal)).toEqual(
    [mine.sessionId, thread.sessionId].sort()
  );
  expect(await listIds(user("u2"))).toEqual(
    [dm.sessionId, thread.sessionId].sort()
  );
  expect(await hidden(user("u1"))).toMatchObject({ code: "not_found" });
  expect(await hidden(principal)).toMatchObject({ code: "not_found" });
  expect((await sessions.transcript(user("u2"), dm.sessionId)).session.id).toBe(
    dm.sessionId
  );
  expect(
    (await sessions.transcript(user("u1"), thread.sessionId)).session.id
  ).toBe(thread.sessionId);
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

test("getRun hides a run of another user's private session as not found", async () => {
  const mine = await send(user("u1"), "private question");
  const unknownId = "01UNKNOWNRUNID000000000000";

  const hidden = await runs
    .getRun(user("u2"), mine.runId)
    .catch((caught: unknown) => caught);
  const missing = await runs
    .getRun(user("u2"), unknownId)
    .catch((caught: unknown) => caught);

  expect(hidden).toBeInstanceOf(ServiceError);
  expect(hidden).toMatchObject({ code: "not_found" });
  expect(hidden).toMatchObject({ message: (missing as ServiceError).message });
  expect((await runs.getRun(user("u1"), mine.runId)).id).toBe(mine.runId);
});

test("getRun finds a run of a shared session for every user", async () => {
  const shared = await startIn(user("u1"), agentId, "text", {
    externalKey: "k",
    origin: "slack",
  });

  expect((await runs.getRun(user("u1"), shared.runId)).id).toBe(shared.runId);
  expect((await runs.getRun(user("u2"), shared.runId)).id).toBe(shared.runId);
});

const insertMachine = (id: string) =>
  db
    .insert(machineRows)
    .values({
      capabilities: "{}",
      createdAt: START,
      credentialHash: `hash-${id}`,
      enrolledBy: "u1",
      id,
      name: "laptop",
      singleUser: false,
      status: "online",
      workspaceId: WORKSPACE,
    })
    .run();

test("transcript has no queue state for a finished run or a running one", async () => {
  const started = await send(user("u1"), "done already");
  expect(
    (await sessions.transcript(user("u1"), started.sessionId)).queue
  ).toBeNull();

  db.update(runRows)
    .set({ status: "running" })
    .where(eq(runRows.id, started.runId))
    .run();

  expect(
    (await sessions.transcript(user("u1"), started.sessionId)).queue
  ).toBeNull();
});

test("a queued run of a machine agent reports the machine runtime, with no other run active", async () => {
  insertMachine("m1");
  const started = await send(user("u1"), "waiting");
  db.update(agentRows)
    .set({ machineId: "m1", runtime: "machine" })
    .where(eq(agentRows.id, agentId))
    .run();
  db.update(runRows)
    .set({ status: "queued" })
    .where(eq(runRows.id, started.runId))
    .run();

  const result = await sessions.transcript(user("u1"), started.sessionId);

  expect(result.queue).toEqual({ otherRunActive: false, runtime: "machine" });
});

test("a queued run reports otherRunActive when another run of the same session is running", async () => {
  const first = await send(user("u1"), "in progress");
  const next = await send(user("u1"), "waiting", first.sessionId);
  db.update(runRows)
    .set({ status: "running" })
    .where(eq(runRows.id, first.runId))
    .run();
  db.update(runRows)
    .set({ status: "queued" })
    .where(eq(runRows.id, next.runId))
    .run();

  const result = await sessions.transcript(user("u1"), first.sessionId);

  expect(result.queue).toEqual({ otherRunActive: true, runtime: "fake" });
});

test("a run running in another session of the agent does not count as otherRunActive", async () => {
  const other = await send(user("u1"), "elsewhere");
  const mine = await send(user("u1"), "waiting");
  db.update(runRows)
    .set({ status: "running" })
    .where(eq(runRows.id, other.runId))
    .run();
  db.update(runRows)
    .set({ status: "queued" })
    .where(eq(runRows.id, mine.runId))
    .run();

  const result = await sessions.transcript(user("u1"), mine.sessionId);

  expect(other.sessionId).not.toBe(mine.sessionId);
  expect(result.queue).toEqual({ otherRunActive: false, runtime: "fake" });
});
