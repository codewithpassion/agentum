import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { files as fileRows } from "@repo/db/schema/files";
import { machines } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import {
  type Blobs,
  createEventsService,
  type EventsService,
} from "./events.ts";
import type {
  Clock,
  DeliveryContext,
  Gateway,
  RuntimeAdapter,
  StartRunInput,
} from "./runs/types.ts";
import {
  createRunsService,
  type RunsService,
  type RunsServiceOptions,
} from "./runs.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "./workspaces.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";
const SECOND = 1000;

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const colleague: Principal = {
  kind: "user",
  userId: "u2",
  via: "session",
  workspaceId: WORKSPACE,
};
const outsider: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "w2",
};

type Db = ReturnType<typeof migrated>;

let db: Db;
let nowMs: number;
let clock: Clock;
let blobs: Blobs;
let dispatched: string[];
let spy: RuntimeAdapter;
let events: EventsService;
let agents: AgentsService;
let runs: RunsService;
let spyAgentId: string;
let fakeAgentId: string;

const advance = (ms: number) => {
  nowMs += ms;
};

/** A runtime that only records the runs it was offered. */
const spyAdapter = (): RuntimeAdapter => ({
  cancel: () => Promise.resolve(),
  dispatch: (_db, run) => {
    dispatched.push(run.id);
    return Promise.resolve();
  },
  kind: "machine",
});

const buildRuns = (overrides: Partial<RunsServiceOptions> = {}): RunsService =>
  createRunsService({
    adapters: [spy],
    atomic: sqliteAtomic(db),
    blobs,
    clock,
    db,
    devFakeRuntime: true,
    gateways: [],
    ...overrides,
  });

const start = (
  principal: Principal,
  agentId: string,
  extra: Partial<StartRunInput> = {},
  text = "hello"
) =>
  runs.startRun(principal, {
    agentId,
    input: { text },
    session: { origin: "ui" },
    ...extra,
  });

/** Resolves to the error the promise rejects with. Fails if it resolves. */
const failure = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject");
};

const runRow = (runId: string) =>
  db.select().from(runRows).where(eq(runRows.id, runId)).get();

const runRowCount = () => db.select().from(runRows).all().length;

const runEvents = (runId: string) =>
  db.select().from(eventRows).where(eq(eventRows.runId, runId)).all();

const sessionEvents = (sessionId: string) =>
  db.select().from(eventRows).where(eq(eventRows.sessionId, sessionId)).all();

const insertFile = (id: string, workspaceId: string, createdById: string) =>
  db
    .insert(fileRows)
    .values({
      createdAt: START,
      createdById,
      createdByKind: "user",
      id,
      mime: "text/plain",
      name: id,
      r2Key: `${workspaceId}/files/${id}`,
      size: 1,
      source: "upload",
      workspaceId,
    })
    .run();

const runPrincipal = (
  runId: string,
  agentId: string,
  workspaceId = WORKSPACE
): Principal => ({ agentId, kind: "run", runId, workspaceId });

beforeEach(async () => {
  db = migrated();
  nowMs = Date.parse(START);
  clock = {
    now: () => new Date(nowMs),
    sleep: (ms) => {
      advance(ms);
      return Promise.resolve();
    },
  };
  dispatched = [];
  spy = spyAdapter();
  const store = new Map<string, string>();
  blobs = {
    get: (key) => Promise.resolve(store.get(key) ?? null),
    put: (key, body) => {
      store.set(key, body);
      return Promise.resolve();
    },
  };
  events = createEventsService({ blobs, db });
  agents = createAgentsService({ db, events });
  db.insert(machines)
    .values({
      capabilities: "{}",
      createdAt: START,
      credentialHash: "h",
      enrolledBy: "u1",
      id: "m1",
      name: "m1",
      singleUser: false,
      status: "online",
      workspaceId: WORKSPACE,
    })
    .run();
  spyAgentId = (
    await agents.create(user, {
      machineId: "m1",
      model: "m",
      name: "Spy",
      runtime: "machine",
    })
  ).id;
  fakeAgentId = (
    await agents.create(user, { model: "m", name: "Fake", runtime: "fake" })
  ).id;
  runs = buildRuns();
});

test("a fake-runtime run finishes with the echo", async () => {
  const started = await start(user, fakeAgentId, {}, "hello");
  expect(started.status).toBe("queued");

  const summary = await runs.waitForRun(user, started.runId, 5000);
  expect(summary).toMatchObject({
    resultText: "Echo: hello",
    status: "done",
  });

  const transcript = await events.transcript(
    user,
    WORKSPACE,
    started.sessionId
  );
  expect(transcript.map((event) => event.type)).toEqual([
    "message.user",
    "message.assistant",
  ]);
  expect(transcript[1]?.payload).toEqual({ text: "Echo: hello" });

  const row = runRow(started.runId);
  expect(row).toMatchObject({
    actorKind: "user",
    depth: 0,
    onBehalfOfUserId: "u1",
    parentRunId: null,
  });
  expect(typeof row?.finishedAt).toBe("string");
});

test("the same requestId returns the same run and inserts nothing", async () => {
  const first = await start(user, spyAgentId, { requestId: "r1" });
  const second = await start(user, spyAgentId, { requestId: "r1" });

  expect(second.runId).toBe(first.runId);
  expect(second.sessionId).toBe(first.sessionId);
  expect(runRowCount()).toBe(1);
  const inSession = sessionEvents(first.sessionId).map((event) => event.type);
  expect(inSession.filter((type) => type === "message.user")).toHaveLength(1);
  expect(inSession.filter((type) => type === "run.queued")).toHaveLength(1);
});

test("a second message with the same session key reuses the session", async () => {
  const slackKey = { externalKey: "T1", origin: "slack" as const };
  const slackFirst = await start(user, spyAgentId, { session: slackKey });
  const slackSecond = await start(user, spyAgentId, { session: slackKey });
  expect(slackSecond.sessionId).toBe(slackFirst.sessionId);
  expect(db.select().from(sessionRows).all()).toHaveLength(1);

  const uiFirst = await start(user, spyAgentId);
  const uiSecond = await start(user, spyAgentId, {
    session: { externalKey: uiFirst.sessionId, origin: "ui" },
  });
  expect(uiSecond.sessionId).toBe(uiFirst.sessionId);

  const inbox = await start(user, spyAgentId, {
    session: { externalKey: "T1", origin: "inbox" },
  });
  expect(inbox.sessionId).not.toBe(slackFirst.sessionId);
});

test("a ui session belongs to the user who opened it", async () => {
  const opened = await start(user, spyAgentId);
  const error = await failure(
    start(colleague, spyAgentId, {
      session: { externalKey: opened.sessionId, origin: "ui" },
    })
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect(error).toMatchObject({ code: "not_found" });
});

test("a run started with a run principal inherits the subject", async () => {
  const parent = await start(user, spyAgentId);
  const child = await start(
    runPrincipal(parent.runId, spyAgentId),
    fakeAgentId,
    { session: { origin: "mcp" } }
  );
  expect(runRow(child.runId)).toMatchObject({
    actorId: spyAgentId,
    actorKind: "agent",
    depth: 1,
    onBehalfOfUserId: "u1",
    parentRunId: parent.runId,
  });

  const second = await start(
    runPrincipal(child.runId, fakeAgentId),
    fakeAgentId,
    { session: { origin: "mcp" } }
  );
  expect(runRow(second.runId)).toMatchObject({
    depth: 2,
    onBehalfOfUserId: "u1",
  });
  const third = await start(
    runPrincipal(second.runId, fakeAgentId),
    fakeAgentId,
    { session: { origin: "mcp" } }
  );
  expect(runRow(third.runId)).toMatchObject({
    depth: 3,
    onBehalfOfUserId: "u1",
  });

  const countBefore = runRowCount();
  const error = await failure(
    start(runPrincipal(third.runId, fakeAgentId), fakeAgentId, {
      session: { origin: "mcp" },
    })
  );
  expect(error).toMatchObject({ code: "invalid" });
  expect(runRowCount()).toBe(countBefore);
});

test("a trigger-started run has a null subject", async () => {
  const trigger: Principal = {
    agentId: spyAgentId,
    kind: "trigger",
    triggerId: "t1",
    workspaceId: WORKSPACE,
  };
  const started = await start(trigger, spyAgentId, {
    session: { origin: "trigger" },
  });
  expect(runRow(started.runId)).toMatchObject({
    actorId: "t1",
    actorKind: "trigger",
    onBehalfOfUserId: null,
  });

  const error = await failure(
    start(trigger, fakeAgentId, { session: { origin: "trigger" } })
  );
  expect(error).toBeInstanceOf(ForbiddenError);
});

test("files must belong to the starting user", async () => {
  insertFile("f1", WORKSPACE, "u1");
  insertFile("f2", WORKSPACE, "u2");
  insertFile("f3", "w2", "u1");

  const otherUsersFile = await failure(
    start(user, spyAgentId, { input: { fileIds: ["f2"], text: "x" } })
  );
  expect(otherUsersFile).toMatchObject({ code: "not_found" });
  const otherWorkspaceFile = await failure(
    start(user, spyAgentId, { input: { fileIds: ["f3"], text: "x" } })
  );
  expect(otherWorkspaceFile).toMatchObject({ code: "not_found" });
  expect(runRowCount()).toBe(0);

  const ok = await start(user, spyAgentId, {
    input: { fileIds: ["f1"], text: "x" },
  });
  expect(runRow(ok.runId)?.inputFileIds).toBe('["f1"]');

  const trigger: Principal = {
    agentId: spyAgentId,
    kind: "trigger",
    triggerId: "t1",
    workspaceId: WORKSPACE,
  };
  const error = await failure(
    start(trigger, spyAgentId, {
      input: { fileIds: ["f1"], text: "x" },
      session: { origin: "trigger" },
    })
  );
  expect(error).toMatchObject({ code: "invalid" });
});

test("an interrupted run refuses events and completion but accepts aborted", async () => {
  const { runId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  advance(91 * SECOND);
  expect(await runs.reapExpiredLeases(SYSTEM_PRINCIPAL)).toEqual({
    interrupted: [runId],
  });

  const eventCount = runEvents(runId).length;
  const late = await failure(
    runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, [
      { payload: { text: "x" }, seq: 1, type: "message.assistant" },
    ])
  );
  expect(late).toMatchObject({ code: "conflict" });
  expect(runEvents(runId)).toHaveLength(eventCount);

  const lateDone = await failure(
    runs.completeRun(SYSTEM_PRINCIPAL, runId, { status: "done", text: "late" })
  );
  expect(lateDone).toMatchObject({ code: "conflict" });
  expect(runRow(runId)).toMatchObject({
    resultText: null,
    status: "interrupted",
  });

  await runs.completeRun(SYSTEM_PRINCIPAL, runId, { status: "aborted" });
  const endedAt = new Date(nowMs).toISOString();
  expect(runRow(runId)).toMatchObject({
    processEndedAt: endedAt,
    status: "interrupted",
  });

  advance(5 * SECOND);
  await runs.completeRun(SYSTEM_PRINCIPAL, runId, { status: "aborted" });
  expect(runRow(runId)).toMatchObject({
    processEndedAt: endedAt,
    status: "interrupted",
  });

  const queued = await start(user, spyAgentId);
  const abortedQueued = await failure(
    runs.completeRun(SYSTEM_PRINCIPAL, queued.runId, { status: "aborted" })
  );
  expect(abortedQueued).toMatchObject({ code: "conflict" });
});

test("the reaper interrupts an expired lease and leaves it there", async () => {
  const { runId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);

  advance(89 * SECOND);
  expect(await runs.reapExpiredLeases(SYSTEM_PRINCIPAL)).toEqual({
    interrupted: [],
  });
  expect(runRow(runId)?.status).toBe("running");

  advance(2 * SECOND);
  expect(await runs.reapExpiredLeases(SYSTEM_PRINCIPAL)).toEqual({
    interrupted: [runId],
  });
  expect(runRow(runId)).toMatchObject({
    error: "Lease expired",
    status: "interrupted",
  });
  expect(runEvents(runId).map((event) => event.type)).toContain(
    "run.interrupted"
  );

  advance(5 * 60 * SECOND);
  dispatched.length = 0;
  await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
  expect(dispatched).not.toContain(runId);
  expect(runRow(runId)?.status).toBe("interrupted");
});

test("the sweep offers a run queued for 61 s and ignores one queued for 30 s", async () => {
  const older = await start(user, spyAgentId);
  advance(31 * SECOND);
  const newer = await start(user, spyAgentId);
  advance(30 * SECOND);

  dispatched.length = 0;
  const result = await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
  expect(dispatched).toEqual([older.runId]);
  expect(result).toEqual({
    downloaded: [],
    failed: [],
    offered: [older.runId],
  });
  expect(dispatched).not.toContain(newer.runId);
});

test("the sweep fetches pending files first", async () => {
  const downloads: unknown[] = [];
  const slack: Gateway = {
    deliver: () => Promise.resolve(),
    downloadPendingFiles: (descriptors) => {
      downloads.push(descriptors);
      return Promise.resolve(["file_1"]);
    },
    kind: "slack",
  };
  runs = buildRuns({ gateways: [slack] });

  const { runId } = await start(user, spyAgentId, {
    reply: { channel: "C", kind: "slack", teamId: "T", threadTs: "1.1" },
  });
  db.update(runRows)
    .set({ pendingFiles: '[{"id":"F1"}]' })
    .where(eq(runRows.id, runId))
    .run();
  advance(61 * SECOND);

  const blocked = await failure(runs.claimRun(SYSTEM_PRINCIPAL, runId));
  expect(blocked).toMatchObject({ code: "conflict" });

  dispatched.length = 0;
  const result = await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
  expect(result.downloaded).toEqual([runId]);
  expect(result.offered).toEqual([runId]);
  expect(dispatched).toEqual([runId]);
  expect(downloads).toEqual([[{ id: "F1" }]]);
  expect(runRow(runId)).toMatchObject({
    inputFileIds: '["file_1"]',
    pendingFiles: null,
  });
});

test("completeRun hands the reply target's gateway the trusted context", async () => {
  const delivered: unknown[] = [];
  const inbox: Gateway = {
    deliver: (target, message, context: DeliveryContext) => {
      delivered.push({ context, message, target });
      return Promise.resolve();
    },
    kind: "inbox",
  };
  runs = buildRuns({ gateways: [inbox] });

  const started = await start(
    user,
    fakeAgentId,
    { reply: { kind: "inbox", threadId: "th1" } },
    "hi"
  );
  expect(delivered).toEqual([
    {
      context: {
        agentId: fakeAgentId,
        onBehalfOfUserId: "u1",
        runId: started.runId,
      },
      message: { fileIds: [], text: "Echo: hi" },
      target: { kind: "inbox", threadId: "th1" },
    },
  ]);

  const noGateway = await failure(
    start(user, spyAgentId, {
      reply: { channel: "C", kind: "slack", teamId: "T", threadTs: "1.1" },
    })
  );
  expect(noGateway).toMatchObject({ code: "invalid" });

  const none = await start(user, fakeAgentId);
  expect(none.status).toBe("queued");
});

test("the fake runtime exists only when devFakeRuntime is true", async () => {
  const withoutFake = buildRuns({ devFakeRuntime: false });
  const before = runRowCount();
  const error = await failure(
    withoutFake.startRun(user, {
      agentId: fakeAgentId,
      input: { text: "hi" },
      session: { origin: "ui" },
    })
  );
  expect(error).toMatchObject({ code: "invalid" });
  expect(runRowCount()).toBe(before);
});

test("cancelRun", async () => {
  const { runId } = await start(user, spyAgentId);
  await runs.cancelRun(user, runId);
  expect(runRow(runId)).toMatchObject({ status: "cancelled" });
  expect(typeof runRow(runId)?.finishedAt).toBe("string");
  expect(runEvents(runId).map((event) => event.type)).toContain(
    "run.cancelled"
  );

  const again = await failure(runs.cancelRun(user, runId));
  expect(again).toMatchObject({ code: "conflict" });

  const done = await start(user, fakeAgentId);
  const doneError = await failure(runs.cancelRun(user, done.runId));
  expect(doneError).toMatchObject({ code: "conflict" });
});

test("ingestRunEvents stores a batch once", async () => {
  const { runId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  const batch = [
    { payload: { text: "one" }, seq: 1, type: "message.assistant" as const },
    { payload: { text: "two" }, seq: 2, type: "message.assistant" as const },
  ];
  expect(await runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, batch)).toEqual({
    lastSeq: 2,
  });
  const again = [
    ...batch,
    { payload: { text: "three" }, seq: 3, type: "message.assistant" as const },
  ];
  expect(await runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, again)).toEqual({
    lastSeq: 3,
  });
  const assistant = runEvents(runId).filter(
    (event) => event.type === "message.assistant"
  );
  expect(assistant.map((event) => event.seq)).toEqual([1, 2, 3]);

  const intruder: Principal = {
    kind: "machine",
    machineId: "m2",
    workspaceId: WORKSPACE,
  };
  const error = await failure(
    runs.ingestRunEvents(intruder, runId, [
      { payload: { text: "x" }, seq: 4, type: "message.assistant" },
    ])
  );
  expect(error).toBeInstanceOf(ForbiddenError);
});

test("workspaces are isolated", async () => {
  const { runId } = await start(user, spyAgentId);
  const startError = await failure(start(outsider, spyAgentId));
  expect(startError).toMatchObject({ code: "not_found" });
  const readError = await failure(runs.getRun(outsider, runId));
  expect(readError).toMatchObject({ code: "not_found" });
});

test("waitForRun returns the pending summary when the time runs out", async () => {
  const { runId } = await start(user, spyAgentId);
  const began = nowMs;
  const summary = await runs.waitForRun(user, runId, 2000);
  expect(summary.status).toBe("queued");
  expect(nowMs - began).toBeGreaterThanOrEqual(2000);
});

test("only the system principal runs the jobs", async () => {
  expect(await failure(runs.sweepQueuedRuns(user))).toBeInstanceOf(
    ForbiddenError
  );
  expect(await failure(runs.reapExpiredLeases(user))).toBeInstanceOf(
    ForbiddenError
  );
});
