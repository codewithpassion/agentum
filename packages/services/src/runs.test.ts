import { beforeEach, expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { files as fileRows } from "@repo/db/schema/files";
import { machines } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { slackEventsSeen } from "@repo/db/schema/slack";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eventsRequestSchema } from "@repo/protocol/machine";
import { file } from "bun";
import { eq, inArray } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { CLOUD_LEASE_MS } from "./cloud/lease.ts";
import { ServiceError } from "./errors.ts";
import {
  type Blobs,
  createEventsService,
  type EventRecord,
  type EventsService,
} from "./events.ts";
import type {
  Clock,
  DeliveryContext,
  Gateway,
  RunEventInput,
  RuntimeAdapter,
  StartRunInput,
  StartRunOptions,
} from "./runs/types.ts";
import {
  createRunsService,
  type RunsService,
  type RunsServiceOptions,
} from "./runs.ts";
import { createSecretsService } from "./secrets.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "./workspaces.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";
const SECOND = 1000;
const RUN_TOKEN_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64"
);

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

/** A runtime that records each run the platform abandons. */
const abandoningAdapter = (abandoned: string[]): RuntimeAdapter => ({
  ...spyAdapter(),
  abandon: (run) => {
    abandoned.push(run.id);
    return Promise.resolve();
  },
});

/** A runtime that records each run it is told to cancel. */
const cancellingAdapter = (cancelled: string[]): RuntimeAdapter => ({
  ...spyAdapter(),
  cancel: (_db, run) => {
    cancelled.push(run.id);
    return Promise.resolve();
  },
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
  text = "hello",
  options?: StartRunOptions
) =>
  runs.startRun(
    principal,
    {
      agentId,
      input: { text },
      session: { origin: "ui" },
      ...extra,
    },
    options
  );

/** Resolves to the error the promise rejects with. Fails if it resolves. */
const failure = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject");
};

/** A second machine agent, so one test can have two runs in flight. */
const addSpyAgent = async () =>
  (
    await agents.create(user, {
      machineId: "m1",
      model: "m",
      name: "Spy 2",
      runtime: "machine",
    })
  ).id;

const runRow = (runId: string) =>
  db.select().from(runRows).where(eq(runRows.id, runId)).get();

const runRowCount = () => db.select().from(runRows).all().length;

const unclaimedRunCount = () =>
  db
    .select({ id: runRows.id })
    .from(runRows)
    .where(inArray(runRows.status, ["queued", "offered"]))
    .all().length;

const runEvents = (runId: string) =>
  db.select().from(eventRows).where(eq(eventRows.runId, runId)).all();

const sessionEvents = (sessionId: string) =>
  db.select().from(eventRows).where(eq(eventRows.sessionId, sessionId)).all();

const insertFile = (
  id: string,
  workspaceId: string,
  createdById: string,
  runId: string | null = null
) =>
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
      runId,
      size: 1,
      source: "upload",
      workspaceId,
    })
    .run();

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
  insertWorkspace(WORKSPACE);
  insertWorkspace("w2");
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

test("a private session belongs to the user who opened it, a channel thread is shared", async () => {
  const dm = await start(user, spyAgentId, {
    session: { externalKey: "dm-1", origin: "slack", private: true },
  });
  const thread = await start(user, spyAgentId, {
    session: { externalKey: "thread-1", origin: "slack" },
  });

  const error = await failure(
    start(colleague, spyAgentId, {
      session: { externalKey: "dm-1", origin: "slack" },
    })
  );
  const joined = await start(colleague, spyAgentId, {
    session: { externalKey: "thread-1", origin: "slack" },
  });

  expect(error).toMatchObject({ code: "not_found" });
  expect(dm.sessionId).not.toBe(thread.sessionId);
  expect(joined.sessionId).toBe(thread.sessionId);
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

test("a run cannot message an agent that is its running ancestor", async () => {
  const parent = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, parent.runId);
  const child = await start(
    runPrincipal(parent.runId, spyAgentId),
    fakeAgentId,
    { session: { origin: "mcp" } }
  );
  // The fake runtime already finished the child; put it back to running.
  db.update(runRows)
    .set({ status: "running" })
    .where(eq(runRows.id, child.runId))
    .run();
  const countBefore = runRowCount();

  // The child answers back to the agent that is waiting on it, and to itself.
  const toParent = await failure(
    start(runPrincipal(child.runId, fakeAgentId), spyAgentId, {
      session: { origin: "mcp" },
    })
  );
  expect(toParent).toMatchObject({ code: "conflict" });
  const toSelf = await failure(
    start(runPrincipal(child.runId, fakeAgentId), fakeAgentId, {
      session: { origin: "mcp" },
    })
  );
  expect(toSelf).toMatchObject({ code: "conflict" });
  expect(runRowCount()).toBe(countBefore);

  // Once the parent is no longer running it is an ordinary target.
  await runs.completeRun(SYSTEM_PRINCIPAL, parent.runId, { status: "done" });
  const later = await start(
    runPrincipal(child.runId, fakeAgentId),
    spyAgentId,
    { session: { origin: "mcp" } }
  );
  expect(runRow(later.runId)).toMatchObject({ depth: 2 });
});

test("a read-only api key cannot start a run", async () => {
  const readKey: Principal = {
    ...user,
    apiKey: { access: "read", id: "k1" },
    via: "api_key",
  };
  const error = await failure(start(readKey, fakeAgentId));
  expect(error).toBeInstanceOf(ForbiddenError);
  const writeKey: Principal = {
    ...user,
    apiKey: { access: "write", id: "k2" },
    via: "api_key",
  };
  expect((await start(writeKey, fakeAgentId)).runId).toBeString();
});

test("a read-only OAuth client cannot start a run", async () => {
  const readClient: Principal = {
    ...user,
    oauthClient: { access: "read", clientId: "c1" },
    via: "oauth",
  };
  const error = await failure(start(readClient, fakeAgentId));
  expect(error).toBeInstanceOf(ForbiddenError);
  const writeClient: Principal = {
    ...user,
    oauthClient: { access: "write", clientId: "c2" },
    via: "oauth",
  };
  expect((await start(writeClient, fakeAgentId)).runId).toBeString();
});

test("a requestId is handed back only to the caller that used it", async () => {
  const first = await start(user, fakeAgentId, { requestId: "msg-1" });
  const again = await start(user, fakeAgentId, { requestId: "msg-1" });
  expect(again.runId).toBe(first.runId);

  const other = await failure(
    start(colleague, fakeAgentId, { requestId: "msg-1" })
  );
  expect(other).toMatchObject({ code: "conflict" });
  const otherAgent = await failure(
    start(user, spyAgentId, { requestId: "msg-1" })
  );
  expect(otherAgent).toMatchObject({ code: "conflict" });
});

test("two runs of one agent do not share a requestId", async () => {
  const parentOne = await start(user, spyAgentId);
  const parentTwo = await start(colleague, spyAgentId);
  const first = await start(
    runPrincipal(parentOne.runId, spyAgentId),
    fakeAgentId,
    { requestId: "msg-1", session: { origin: "mcp" } }
  );
  const retry = await start(
    runPrincipal(parentOne.runId, spyAgentId),
    fakeAgentId,
    { requestId: "msg-1", session: { origin: "mcp" } }
  );
  expect(retry.runId).toBe(first.runId);

  const sibling = await failure(
    start(runPrincipal(parentTwo.runId, spyAgentId), fakeAgentId, {
      requestId: "msg-1",
      session: { origin: "mcp" },
    })
  );
  expect(sibling).toMatchObject({ code: "conflict" });
});

test("a run reads its own agent's runs and the runs it started, not others", async () => {
  const mine = await start(user, spyAgentId);
  const theirs = await start(user, fakeAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, mine.runId);
  const principal = runPrincipal(mine.runId, spyAgentId);
  const child = await start(principal, fakeAgentId, {
    session: { origin: "mcp" },
  });

  expect((await runs.getRun(principal, mine.runId)).id).toBe(mine.runId);
  expect((await runs.getRun(principal, child.runId)).id).toBe(child.runId);
  const error = await failure(runs.getRun(principal, theirs.runId));
  expect(error).toMatchObject({ code: "not_found" });
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

test("an interrupted run refuses events and completion but accepts aborted once", async () => {
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
  const repeated = await failure(
    runs.completeRun(SYSTEM_PRINCIPAL, runId, { status: "aborted" })
  );
  expect(repeated).toMatchObject({ code: "conflict" });
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
  expect(
    runEvents(runId).find((event) => event.type === "run.interrupted")
  ).toMatchObject({ actorId: "tick", actorKind: "system" });

  advance(5 * 60 * SECOND);
  dispatched.length = 0;
  await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
  expect(dispatched).not.toContain(runId);
  expect(runRow(runId)?.status).toBe("interrupted");
});

test("the reaper abandons an interrupted run and not one whose lease is live", async () => {
  const abandoned: string[] = [];
  runs = buildRuns({ adapters: [abandoningAdapter(abandoned)] });
  const expired = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, expired.runId);
  advance(60 * SECOND);
  const live = await start(user, await addSpyAgent());
  await runs.claimRun(SYSTEM_PRINCIPAL, live.runId);

  advance(31 * SECOND);
  expect(await runs.reapExpiredLeases(SYSTEM_PRINCIPAL)).toEqual({
    interrupted: [expired.runId],
  });
  expect(abandoned).toEqual([expired.runId]);
  expect(runRow(live.runId)?.status).toBe("running");
});

test("a throwing abandon is logged and does not stop the reaper", async () => {
  const logged = spyOn(console, "error").mockImplementation(() => undefined);
  const called: string[] = [];
  runs = buildRuns({
    adapters: [
      {
        ...spyAdapter(),
        abandon: (run) => {
          called.push(run.id);
          return Promise.reject(new Error("boom"));
        },
      },
    ],
  });
  try {
    const first = await start(user, spyAgentId);
    await runs.claimRun(SYSTEM_PRINCIPAL, first.runId);
    const second = await start(user, await addSpyAgent());
    await runs.claimRun(SYSTEM_PRINCIPAL, second.runId);

    advance(91 * SECOND);
    const { interrupted } = await runs.reapExpiredLeases(SYSTEM_PRINCIPAL);
    const ids = [first.runId, second.runId].sort();
    expect([...interrupted].sort()).toEqual(ids);
    expect([...called].sort()).toEqual(ids);
    expect(runRow(first.runId)?.status).toBe("interrupted");
    expect(runRow(second.runId)?.status).toBe("interrupted");
    expect(logged).toHaveBeenCalledTimes(2);
  } finally {
    logged.mockRestore();
  }
});

test("a claim takes the lease length the system asks for, 90 s by default", async () => {
  const cloud = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, cloud.runId, {
    leaseMs: CLOUD_LEASE_MS,
  });
  expect(runRow(cloud.runId)?.leaseUntil).toBe(
    new Date(nowMs + CLOUD_LEASE_MS).toISOString()
  );

  const plain = await start(user, await addSpyAgent());
  await runs.claimRun(SYSTEM_PRINCIPAL, plain.runId);
  expect(runRow(plain.runId)?.leaseUntil).toBe(
    new Date(nowMs + 90 * SECOND).toISOString()
  );
});

test("a heartbeat with a lease length extends to it, and a machine cannot choose one", async () => {
  const machineRuns = buildRuns({ runTokenKey: RUN_TOKEN_KEY });
  const machine: Principal = {
    kind: "machine",
    machineId: "m1",
    workspaceId: WORKSPACE,
  };
  const { runId } = await start(user, spyAgentId);
  await machineRuns.claimRunForMachine(machine, runId, {
    platformUrl: "https://example.test",
  });

  await runs.heartbeatRun(SYSTEM_PRINCIPAL, runId, {
    leaseMs: CLOUD_LEASE_MS,
  });
  expect(runRow(runId)?.leaseUntil).toBe(
    new Date(nowMs + CLOUD_LEASE_MS).toISOString()
  );

  const refused = await failure(
    machineRuns.heartbeatRun(machine, runId, { leaseMs: CLOUD_LEASE_MS })
  );
  expect(refused).toBeInstanceOf(ForbiddenError);

  advance(SECOND);
  await machineRuns.heartbeatRun(machine, runId);
  expect(runRow(runId)?.leaseUntil).toBe(
    new Date(nowMs + 90 * SECOND).toISOString()
  );
});

test("a cloud lease rides out a daemon outage that the default lease does not", async () => {
  const cloud = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, cloud.runId, {
    leaseMs: CLOUD_LEASE_MS,
  });
  const plain = await start(user, await addSpyAgent());
  await runs.claimRun(SYSTEM_PRINCIPAL, plain.runId);
  await runs.heartbeatRun(SYSTEM_PRINCIPAL, cloud.runId, {
    leaseMs: CLOUD_LEASE_MS,
  });

  advance(120 * SECOND);
  expect(await runs.reapExpiredLeases(SYSTEM_PRINCIPAL)).toEqual({
    interrupted: [plain.runId],
  });
  expect(runRow(cloud.runId)).toMatchObject({ status: "running" });
  expect(Date.parse(runRow(cloud.runId)?.leaseUntil ?? "")).toBeGreaterThan(
    nowMs
  );
});

test("the reaper interrupts a cloud run once its 10 minute lease has passed", async () => {
  const { runId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId, { leaseMs: CLOUD_LEASE_MS });

  advance(CLOUD_LEASE_MS - SECOND);
  expect(await runs.reapExpiredLeases(SYSTEM_PRINCIPAL)).toEqual({
    interrupted: [],
  });

  advance(2 * SECOND);
  expect(await runs.reapExpiredLeases(SYSTEM_PRINCIPAL)).toEqual({
    interrupted: [runId],
  });
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

test("the sweep reaches a crash-left run behind more than 100 runs nobody claims", async () => {
  for (let i = 0; i < 105; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: seeds run in order so each gets a later createdAt
    await start(user, spyAgentId, {}, "hello", { offerLater: true });
    advance(SECOND);
  }
  const crashed = await start(user, spyAgentId, {}, "hello", {
    offerLater: true,
  });
  advance(61 * SECOND);

  dispatched.length = 0;
  await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
  advance(61 * SECOND);
  await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
  expect(dispatched).toContain(crashed.runId);
});

test("the sweep fails a run nobody claimed for an hour and keeps a younger one", async () => {
  const { runId } = await start(user, spyAgentId, {}, "hello", {
    offerLater: true,
  });
  advance(59 * 60 * SECOND);
  const young = await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
  expect(young.failed).toEqual([]);
  expect(runRow(runId)?.status).toBe("queued");

  advance(2 * 60 * SECOND);
  dispatched.length = 0;
  const expired = await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
  expect(expired.failed).toEqual([{ message: "Never claimed", runId }]);
  expect(runRow(runId)).toMatchObject({
    error: "Never claimed",
    status: "failed",
  });
  expect(runRow(runId)?.finishedAt).not.toBeNull();
  expect(
    runEvents(runId).find((event) => event.type === "run.failed")
  ).toMatchObject({ actorKind: "system" });
  expect(dispatched).not.toContain(runId);
});

test("the sweep abandons a run it fails as never claimed", async () => {
  const abandoned: string[] = [];
  runs = buildRuns({ adapters: [abandoningAdapter(abandoned)] });
  const { runId } = await start(user, spyAgentId, {}, "hello", {
    offerLater: true,
  });
  advance(61 * 60 * SECOND);

  const swept = await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
  expect(swept.failed).toEqual([{ message: "Never claimed", runId }]);
  expect(abandoned).toEqual([runId]);
});

test("a claim that lands before expiry keeps the run past the sweep", async () => {
  const { runId } = await start(user, spyAgentId);
  advance(59 * 60 * SECOND);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);

  advance(2 * 60 * SECOND);
  await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
  expect(runRow(runId)?.status).toBe("running");
  expect(runEvents(runId).map((event) => event.type)).not.toContain(
    "run.failed"
  );
});

/**
 * Runs `minutes` minutes of never-claimed traffic, one run a minute, each
 * swept a minute after it starts. Then starts a crash-left run and sweeps
 * until it is offered. Returns the most runs queued or offered at once and
 * the passes the crash-left run took.
 */
const unclaimedBacklog = async (minutes: number) => {
  const maxPasses = 10;
  let peak = 0;
  for (let minute = 0; minute < minutes; minute += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each minute's run is created and swept before the next
    await start(user, spyAgentId, {}, "hello", { offerLater: true });
    advance(60 * SECOND);
    await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
    peak = Math.max(peak, unclaimedRunCount());
  }
  const crashed = await start(user, spyAgentId, {}, "hello", {
    offerLater: true,
  });
  advance(61 * SECOND);

  dispatched.length = 0;
  let passes = 0;
  do {
    passes += 1;
    // biome-ignore lint/performance/noAwaitInLoops: each pass must finish before the next one advances the clock
    await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
    advance(60 * SECOND);
  } while (!dispatched.includes(crashed.runId) && passes < maxPasses);
  return { passes, peak };
};

test("an hour of never-claimed runs stays bounded and the sweep still reaches a crash-left run", async () => {
  const short = await unclaimedBacklog(200);
  const long = await unclaimedBacklog(3000);

  expect(short.peak).toBeLessThan(100);
  expect(long.peak).toBeLessThan(100);
  expect(short.passes).toBeLessThanOrEqual(3);
  expect(long.passes).toBe(short.passes);
}, 60_000);

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

test("completeRun accepts only files of its own run", async () => {
  const delivered: unknown[] = [];
  const inbox: Gateway = {
    deliver: (target, message) => {
      delivered.push({ message, target });
      return Promise.resolve();
    },
    kind: "inbox",
  };
  runs = buildRuns({ gateways: [inbox] });
  const reply = { kind: "inbox" as const, threadId: "th1" };

  const run1 = await start(user, spyAgentId, { reply });
  const run2 = await start(user, spyAgentId, { reply });
  await runs.claimRun(SYSTEM_PRINCIPAL, run1.runId);

  insertFile("own", WORKSPACE, "u1", run1.runId);
  insertFile("upload", WORKSPACE, "u2");
  insertFile("other-run", WORKSPACE, "u1", run2.runId);
  insertFile("other-ws", "w2", "u1", run1.runId);

  const before = delivered.length;
  const attempts = ["upload", "other-run", "other-ws"].flatMap((foreign) => [
    [foreign],
    ["own", foreign],
  ]);
  const errors = await Promise.all(
    attempts.map((fileIds) =>
      failure(
        runs.completeRun(SYSTEM_PRINCIPAL, run1.runId, {
          fileIds,
          status: "done",
          text: "x",
        })
      )
    )
  );
  for (const error of errors) {
    expect(error).toMatchObject({ code: "not_found" });
  }
  expect(runRow(run1.runId)?.status).toBe("running");
  expect(delivered).toHaveLength(before);

  await runs.completeRun(SYSTEM_PRINCIPAL, run1.runId, {
    fileIds: ["own"],
    status: "done",
    text: "ok",
  });
  expect(runRow(run1.runId)).toMatchObject({
    outputFileIds: '["own"]',
    status: "done",
  });
  expect(delivered.slice(before)).toEqual([
    {
      message: { fileIds: ["own"], text: "ok" },
      target: { kind: "inbox", threadId: "th1" },
    },
  ]);
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

test("cancelRun hides a run of another user's private session as not found", async () => {
  const { runId } = await start(user, spyAgentId);

  const hidden = await failure(runs.cancelRun(colleague, runId));
  expect(hidden).toMatchObject({ code: "not_found" });
  expect(runRow(runId)).toMatchObject({ status: "queued" });

  await runs.cancelRun(user, runId);
  expect(runRow(runId)).toMatchObject({ status: "cancelled" });
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

test("ingestRunEvents stores the protocol fixture once", async () => {
  const { runId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  const request = eventsRequestSchema.parse(
    await file(
      new URL("../../protocol/fixtures/events-request.json", import.meta.url)
    ).json()
  );
  expect(
    await runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, request.events)
  ).toEqual({ lastSeq: 3 });
  expect(
    await runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, request.events)
  ).toEqual({ lastSeq: 3 });

  const fixtureTypes = ["message.assistant", "tool.call", "tool.result"];
  const stored = runEvents(runId).filter((event) =>
    fixtureTypes.includes(event.type)
  );
  expect(stored.map((event) => [event.type, event.seq])).toEqual([
    ["message.assistant", 1],
    ["tool.call", 2],
    ["tool.result", 3],
  ]);
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

test("completeRun stores the runtime ref on the session with the result", async () => {
  const { runId, sessionId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await runs.completeRun(SYSTEM_PRINCIPAL, runId, {
    runtimeRef: "cc-session-1",
    status: "done",
    text: "ok",
  });
  expect(runRow(runId)).toMatchObject({ status: "done" });
  const [session] = db
    .select()
    .from(sessionRows)
    .where(eq(sessionRows.id, sessionId))
    .all();
  expect(session?.runtimeRef).toBe("cc-session-1");
});

test("a refused completion does not touch the session", async () => {
  const { runId, sessionId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  advance(91 * SECOND);
  await runs.reapExpiredLeases(SYSTEM_PRINCIPAL);
  const late = await failure(
    runs.completeRun(SYSTEM_PRINCIPAL, runId, {
      runtimeRef: "cc-late",
      status: "done",
    })
  );
  expect(late).toMatchObject({ code: "conflict" });
  const [session] = db
    .select()
    .from(sessionRows)
    .where(eq(sessionRows.id, sessionId))
    .all();
  expect(session?.runtimeRef).toBeNull();
});

test("two identical completions in flight finish the run once", async () => {
  // A clock that moves on every read, so the two writes never share a time.
  const ticking: Clock = {
    now: () => {
      nowMs += 1;
      return new Date(nowMs);
    },
    sleep: clock.sleep,
  };
  const racing = buildRuns({ clock: ticking });
  const { runId } = await start(user, spyAgentId);
  await racing.claimRun(SYSTEM_PRINCIPAL, runId);

  const outcomes = await Promise.allSettled([
    racing.completeRun(SYSTEM_PRINCIPAL, runId, { status: "done", text: "a" }),
    racing.completeRun(SYSTEM_PRINCIPAL, runId, { status: "done", text: "b" }),
  ]);

  expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  const loser = outcomes.find((outcome) => outcome.status === "rejected");
  expect(loser?.status === "rejected" && loser.reason).toMatchObject({
    code: "conflict",
  });
  expect(
    runEvents(runId).filter((event) => event.type === "run.finished")
  ).toHaveLength(1);
});

const slackGateway = (download: Gateway["downloadPendingFiles"]): Gateway => ({
  deliver: () => Promise.resolve(),
  downloadPendingFiles: download,
  kind: "slack",
});

const SLACK_REPLY: StartRunInput["reply"] = {
  channel: "C",
  kind: "slack",
  teamId: "T",
  threadTs: "1.1",
};

test("startRun with pending files stores them, holds the run back and runs the extra writes in the same atomic write", async () => {
  runs = buildRuns({ gateways: [slackGateway(() => Promise.resolve([]))] });
  const seen = (forRun: string | null) =>
    db.insert(slackEventsSeen).values({
      eventHash: "h1",
      id: "seen1",
      receivedAt: START,
      runId: forRun,
      workspaceId: WORKSPACE,
    });

  const { runId } = await start(
    user,
    spyAgentId,
    { reply: SLACK_REPLY },
    "hello",
    { alongside: (ids) => [seen(ids.runId)], pendingFiles: [{ id: "F1" }] }
  );

  expect(runRow(runId)).toMatchObject({
    pendingFiles: '[{"id":"F1"}]',
    status: "queued",
  });
  expect(dispatched).toEqual([]);
  expect(db.select().from(slackEventsSeen).all()).toMatchObject([
    { eventHash: "h1", runId },
  ]);
  const blocked = await failure(runs.claimRun(SYSTEM_PRINCIPAL, runId));
  expect(blocked).toMatchObject({ code: "conflict" });

  // The same extra write again fails on the unique hash, and the run with it.
  const before = runRowCount();
  await failure(
    start(user, spyAgentId, { reply: SLACK_REPLY }, "again", {
      alongside: (ids) => [seen(ids.runId)],
    })
  );
  expect(runRowCount()).toBe(before);
});

test("fetchPendingFiles stores the files, clears the descriptors and offers the run", async () => {
  runs = buildRuns({
    gateways: [slackGateway(() => Promise.resolve(["file_1"]))],
  });
  const { runId } = await start(
    user,
    spyAgentId,
    { reply: SLACK_REPLY },
    "hello",
    { pendingFiles: [{ id: "F1" }] }
  );

  expect(await runs.fetchPendingFiles(SYSTEM_PRINCIPAL, runId)).toBe(
    "downloaded"
  );
  expect(dispatched).toEqual([runId]);
  expect(runRow(runId)).toMatchObject({
    inputFileIds: '["file_1"]',
    pendingFiles: null,
  });
  expect(await runs.fetchPendingFiles(SYSTEM_PRINCIPAL, runId)).toBe("skipped");
  const notSystem = await failure(runs.fetchPendingFiles(user, runId));
  expect(notSystem).toBeInstanceOf(ForbiddenError);
});

test("the third failed download fails the run with an event", async () => {
  runs = buildRuns({
    gateways: [slackGateway(() => Promise.reject(new Error("slack is down")))],
  });
  const { runId } = await start(
    user,
    spyAgentId,
    { reply: SLACK_REPLY },
    "hello",
    { pendingFiles: [{ id: "F1" }] }
  );

  const first = await failure(runs.fetchPendingFiles(SYSTEM_PRINCIPAL, runId));
  expect(first).toMatchObject({ message: "slack is down" });
  advance(61 * SECOND);
  const swept = await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
  expect(swept.failed).toMatchObject([{ message: "slack is down", runId }]);
  expect(runRow(runId)).toMatchObject({
    pendingAttempts: 2,
    status: "queued",
  });

  expect(await runs.fetchPendingFiles(SYSTEM_PRINCIPAL, runId)).toBe("failed");
  expect(runRow(runId)).toMatchObject({
    error: "Could not download the attached files",
    pendingAttempts: 3,
    status: "failed",
  });
  expect(runEvents(runId).map((event) => event.type)).toContain("run.failed");
  dispatched.length = 0;
  advance(61 * SECOND);
  await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
  expect(dispatched).toEqual([]);
});

test("offerLater puts the run's events in the atomic write and offers nothing until offerQueuedRun", async () => {
  const { runId } = await start(user, spyAgentId, {}, "hello", {
    offerLater: true,
  });

  expect(dispatched).toEqual([]);
  expect(runEvents(runId).map((event) => event.type)).toEqual([
    "run.queued",
    "message.user",
  ]);
  const notSystem = await failure(runs.offerQueuedRun(user, runId));
  expect(notSystem).toBeInstanceOf(ForbiddenError);

  await runs.offerQueuedRun(SYSTEM_PRINCIPAL, runId);
  expect(dispatched).toEqual([runId]);
});

test("a failing extra write rolls back the run's events too", async () => {
  const bad = () =>
    db.insert(slackEventsSeen).values({
      eventHash: "h2",
      id: "seen2",
      receivedAt: START,
      runId: "no-such-run",
      workspaceId: WORKSPACE,
    });

  const before = runRowCount();
  await failure(
    start(user, spyAgentId, {}, "hello", {
      alongside: () => [bad()],
      offerLater: true,
    })
  );

  expect(runRowCount()).toBe(before);
  expect(
    db
      .select()
      .from(eventRows)
      .all()
      .filter((event) => event.runId !== null)
  ).toEqual([]);
});

test("two downloads of one run's files never overlap", async () => {
  const releases: ((ids: string[]) => void)[] = [];
  runs = buildRuns({
    gateways: [
      slackGateway(
        () =>
          new Promise<string[]>((resolve) => {
            releases.push(resolve);
          })
      ),
    ],
  });
  const settle = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  const { runId } = await start(
    user,
    spyAgentId,
    { reply: SLACK_REPLY },
    "hello",
    { pendingFiles: [{ id: "F1" }] }
  );

  const first = runs.fetchPendingFiles(SYSTEM_PRINCIPAL, runId);
  await settle();
  expect(await runs.fetchPendingFiles(SYSTEM_PRINCIPAL, runId)).toBe("skipped");
  expect(releases).toHaveLength(1);

  releases[0]?.(["file_1"]);
  expect(await first).toBe("downloaded");
  expect(dispatched).toEqual([runId]);
  expect(runRow(runId)).toMatchObject({ leaseUntil: null, pendingFiles: null });

  // A holder that died frees the run once its lease has passed.
  db.update(runRows)
    .set({ pendingFiles: '[{"id":"F2"}]' })
    .where(eq(runRows.id, runId))
    .run();
  const lost = runs.fetchPendingFiles(SYSTEM_PRINCIPAL, runId);
  await settle();
  advance(6 * 60 * SECOND);
  const retry = runs.fetchPendingFiles(SYSTEM_PRINCIPAL, runId);
  await settle();
  expect(releases).toHaveLength(3);
  for (const release of releases.slice(1)) {
    release([]);
  }
  await Promise.all([lost, retry]);
});

test("a second queued run of an agent waits while its first run is running", async () => {
  const first = await start(user, spyAgentId);
  const second = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, first.runId);

  const blocked = await failure(runs.claimRun(SYSTEM_PRINCIPAL, second.runId));
  expect(blocked).toMatchObject({ code: "conflict" });
  expect(runRow(second.runId)).toMatchObject({ status: "queued" });

  await runs.completeRun(SYSTEM_PRINCIPAL, first.runId, {
    status: "done",
    text: "ok",
  });
  await runs.claimRun(SYSTEM_PRINCIPAL, second.runId);
  expect(runRow(second.runId)).toMatchObject({ status: "running" });
});

test("a younger run of a session waits for its older queued run", async () => {
  const session = { externalKey: "S1", origin: "slack" as const };
  const older = await start(user, spyAgentId, { session });
  advance(SECOND);
  const younger = await start(user, spyAgentId, { session });
  expect(younger.sessionId).toBe(older.sessionId);

  const blocked = await failure(runs.claimRun(SYSTEM_PRINCIPAL, younger.runId));
  expect(blocked).toMatchObject({ code: "conflict" });
  expect(runRow(younger.runId)).toMatchObject({ status: "queued" });

  await runs.claimRun(SYSTEM_PRINCIPAL, older.runId);
  expect(runRow(older.runId)).toMatchObject({ status: "running" });
});

test("two simultaneous claims of one run have one winner", async () => {
  const { runId } = await start(user, spyAgentId);

  const outcomes = await Promise.allSettled([
    runs.claimRun(SYSTEM_PRINCIPAL, runId),
    runs.claimRun(SYSTEM_PRINCIPAL, runId),
  ]);

  expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  const loser = outcomes.find((outcome) => outcome.status === "rejected");
  expect(loser?.status === "rejected" && loser.reason).toMatchObject({
    code: "conflict",
  });
  expect(
    runEvents(runId).filter((event) => event.type === "run.started")
  ).toHaveLength(1);
});

test("releaseRun puts a claimed run back to offered and lets it be claimed again", async () => {
  const { runId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);

  await runs.releaseRun(SYSTEM_PRINCIPAL, runId);
  expect(runRow(runId)).toMatchObject({
    claimedBy: null,
    leaseUntil: null,
    startedAt: null,
    status: "offered",
  });

  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  expect(runRow(runId)).toMatchObject({
    claimedBy: "system",
    status: "running",
  });
});

test("releaseRun leaves a cancelled run cancelled", async () => {
  const { runId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await runs.cancelRun(user, runId);

  await runs.releaseRun(SYSTEM_PRINCIPAL, runId);
  expect(runRow(runId)).toMatchObject({ status: "cancelled" });
});

const GRANTED_VALUE = "granted-value-0123456789";
const SPACED_VALUE = "granted value/with+chars&more=1";

/** A runs service whose spy agents hold one granted secret. */
const maskingRuns = async (agentIds: string[], value = GRANTED_VALUE) => {
  const secrets = createSecretsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    secretsKey: Buffer.from(new Uint8Array(32).fill(5)).toString("base64"),
  });
  const secret = await secrets.create(user, {
    mode: "env",
    name: "OPENAI_API_KEY",
    value,
  });
  for (const agentId of agentIds) {
    // biome-ignore lint/performance/noAwaitInLoops: two agents, one after the other
    await secrets.setGrants(user, agentId, [secret.id]);
  }
  return buildRuns({ secrets });
};

test("a granted secret value is masked in the events a run ingests", async () => {
  runs = await maskingRuns([spyAgentId]);
  const { runId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, [
    {
      payload: { ok: true, output: `key is ${GRANTED_VALUE}` },
      seq: 1,
      type: "tool.result",
    },
    {
      payload: { input: { nested: [JSON.stringify({ k: GRANTED_VALUE })] } },
      seq: 2,
      type: "tool.call",
    },
  ]);
  const stored = JSON.stringify(
    runEvents(runId).filter((event) => event.seq !== null)
  );
  expect(stored).not.toContain(GRANTED_VALUE);
  expect(stored).toContain("[secret:OPENAI_API_KEY]");
});

test("a granted secret value is masked in a run's result text and error", async () => {
  const failedAgent = await addSpyAgent();
  runs = await maskingRuns([spyAgentId, failedAgent]);
  const done = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, done.runId);
  await runs.completeRun(SYSTEM_PRINCIPAL, done.runId, {
    status: "done",
    text: `the key was ${GRANTED_VALUE}`,
  });
  expect(runRow(done.runId)?.resultText).toBe(
    "the key was [secret:OPENAI_API_KEY]"
  );

  const failed = await start(user, failedAgent);
  await runs.claimRun(SYSTEM_PRINCIPAL, failed.runId);
  await runs.completeRun(SYSTEM_PRINCIPAL, failed.runId, {
    error: `401 for ${GRANTED_VALUE}`,
    status: "failed",
  });
  expect(runRow(failed.runId)?.error).toBe("401 for [secret:OPENAI_API_KEY]");
  expect(JSON.stringify(runEvents(failed.runId))).not.toContain(GRANTED_VALUE);
});

test("a run whose agent holds no grant is stored as it came", async () => {
  const bareAgent = await addSpyAgent();
  runs = await maskingRuns([spyAgentId]);
  const { runId } = await start(user, bareAgent);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, [
    { payload: { text: GRANTED_VALUE }, seq: 1, type: "message.assistant" },
  ]);
  expect(JSON.stringify(runEvents(runId))).toContain(GRANTED_VALUE);
});

const payloadOf = (runId: string, type: string): unknown => {
  const row = runEvents(runId).find((event) => event.type === type);
  return JSON.parse(row?.payload ?? "null");
};

const PERCENT_SPACE = "%20";
const FORM_SPACE = "+";
const HAND_TYPED_KEY = "sk-test-1234567890abcdef";
const HAND_TYPED_COMMAND = `curl -H "x-api-key: ${HAND_TYPED_KEY}" https://example.com`;

/** A secret as a tool may write it: plain, base64, URL-encoded, form-encoded. */
const secretForms = (value: string): string[] => {
  const urlEncoded = encodeURIComponent(value);
  return [
    value,
    Buffer.from(value).toString("base64"),
    urlEncoded,
    urlEncoded.replaceAll(PERCENT_SPACE, FORM_SPACE),
  ];
};

test("a granted secret in its plain, base64, URL and form-encoded forms is masked in a run's events", async () => {
  runs = await maskingRuns([spyAgentId], SPACED_VALUE);
  const forms = secretForms(SPACED_VALUE);
  const { runId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, [
    {
      payload: {
        input: { command: forms.map((form) => `echo ${form}`).join(" && ") },
      },
      seq: 1,
      type: "tool.call",
    },
    {
      payload: { ok: true, output: forms.join("\n") },
      seq: 2,
      type: "tool.result",
    },
  ]);
  const stored = JSON.stringify(runEvents(runId));
  for (const form of forms) {
    expect(stored).not.toContain(form);
  }
  expect(stored).toContain("[secret:OPENAI_API_KEY]");
});

test("a hand-typed API key that is not a granted secret is redacted, the rest of the command kept", async () => {
  runs = await maskingRuns([spyAgentId]);
  const { runId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, [
    {
      payload: { input: { command: HAND_TYPED_COMMAND } },
      seq: 1,
      type: "tool.call",
    },
  ]);
  const stored = JSON.stringify(payloadOf(runId, "tool.call"));
  expect(stored).not.toContain(HAND_TYPED_KEY);
  expect(stored).toContain("[redacted]");
  expect(stored).toContain("curl");
  expect(stored).toContain("https://example.com");
});

test("ordinary tool text that mentions a token or password is stored unchanged", async () => {
  runs = await maskingRuns([spyAgentId]);
  const output = "token count is 5, see the password reset page";
  const { runId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, [
    { payload: { ok: true, output }, seq: 1, type: "tool.result" },
  ]);
  expect(payloadOf(runId, "tool.result")).toEqual({ ok: true, output });
});

test("a turn-limit stop ends the run failed with its line and event", async () => {
  const { runId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await runs.completeRun(SYSTEM_PRINCIPAL, runId, {
    status: "failed",
    stop: { kind: "turn_limit", limit: 100 },
  });
  expect(runRow(runId)).toMatchObject({
    error: "Stopped after 100 turns, the agent's limit",
    status: "failed",
  });
  expect(
    runEvents(runId)
      .map((event) => event.type)
      .slice(-2)
  ).toEqual(["run.limit_reached", "run.failed"]);
  expect(payloadOf(runId, "run.limit_reached")).toMatchObject({ limit: 100 });
});

test("a repeat stop ends the run failed with its line and event", async () => {
  const { runId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await runs.completeRun(SYSTEM_PRINCIPAL, runId, {
    error: "ignored by the stop",
    status: "failed",
    stop: { count: 5, kind: "repeat", tool: "run_skill_script" },
  });
  expect(runRow(runId)).toMatchObject({
    error:
      "Stopped after 5 identical failed calls to run_skill_script in a row",
    status: "failed",
  });
  expect(
    runEvents(runId)
      .map((event) => event.type)
      .slice(-2)
  ).toEqual(["run.repeat_stopped", "run.failed"]);
  expect(payloadOf(runId, "run.repeat_stopped")).toMatchObject({
    count: 5,
    tool: "run_skill_script",
  });
});

test("a user cancels a running run as cancelled and keeps its earlier events", async () => {
  const { runId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, [
    { payload: { text: "working" }, seq: 1, type: "message.assistant" },
  ]);
  await runs.cancelRun(user, runId);
  expect(runRow(runId)).toMatchObject({ status: "cancelled" });
  const recorded = runEvents(runId);
  const cancelled = recorded.filter((event) => event.type === "run.cancelled");
  expect(cancelled).toHaveLength(1);
  expect(cancelled[0]).toMatchObject({ actorId: "u1", actorKind: "user" });
  expect(recorded.map((event) => event.type)).toContain("message.assistant");
});

test("cancelling a queued run frees the agent for its next run", async () => {
  const session = { externalKey: "chat", origin: "ui" as const };
  const first = await start(user, spyAgentId, { session });
  advance(SECOND);
  const second = await start(user, spyAgentId, { session });
  expect(
    await failure(runs.claimRun(SYSTEM_PRINCIPAL, second.runId))
  ).toMatchObject({ code: "conflict" });

  await runs.cancelRun(user, first.runId);
  expect(runRow(first.runId)).toMatchObject({ status: "cancelled" });
  await runs.claimRun(SYSTEM_PRINCIPAL, second.runId);
  expect(runRow(second.runId)).toMatchObject({ status: "running" });
});

test("cancelling a running run offers the agent's next waiting run", async () => {
  const offering: RuntimeAdapter = { ...spyAdapter(), offerNextOnEnd: true };
  runs = buildRuns({ adapters: [offering] });
  const running = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, running.runId);
  const waiting = await start(user, spyAgentId);
  dispatched = [];

  await runs.cancelRun(user, running.runId);
  expect(runRow(running.runId)).toMatchObject({ status: "cancelled" });
  expect(dispatched).toEqual([waiting.runId]);
});

test("a run cannot cancel a run", async () => {
  const { runId } = await start(user, spyAgentId);
  const error = await failure(
    runs.cancelRun(runPrincipal(runId, spyAgentId), runId)
  );
  expect(error).toBeInstanceOf(ForbiddenError);
  expect(runRow(runId)).toMatchObject({ status: "queued" });
  expect(runEvents(runId).map((event) => event.type)).not.toContain(
    "run.cancelled"
  );
});

const PATH_A = { path: "a" };
const PATH_B = { path: "b" };

/** One tool call and its result: a failed or a successful round, with its input. */
interface Round {
  input?: { path: string };
  ok: boolean;
}
const FAIL: Round = { ok: false };
const OK: Round = { ok: true };
const OTHER_FAIL: Round = { input: PATH_B, ok: false };

/** The rounds as tool events, numbered from `firstSeq`: each call, then its result. */
const rounds = (
  firstSeq: number,
  outcomes: readonly Round[]
): RunEventInput[] =>
  outcomes.flatMap((round, index): RunEventInput[] => {
    const seq = firstSeq + index * 2;
    const toolUseId = `t${seq}`;
    return [
      {
        payload: {
          input: round.input ?? PATH_A,
          name: "read_file",
          toolUseId,
        },
        seq,
        type: "tool.call",
      },
      {
        payload: { ok: round.ok, output: "out", toolUseId },
        seq: seq + 1,
        type: "tool.result",
      },
    ];
  });

/** A machine run claimed and running. */
const claimedRun = async (agentId = spyAgentId): Promise<string> => {
  const { runId } = await start(user, agentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  return runId;
};

test("five identical failed calls in one batch stop the run and cancel it", async () => {
  const cancelled: string[] = [];
  runs = buildRuns({ adapters: [cancellingAdapter(cancelled)] });
  const runId = await claimedRun();
  expect(
    await runs.ingestRunEvents(
      SYSTEM_PRINCIPAL,
      runId,
      rounds(1, [FAIL, FAIL, FAIL, FAIL, FAIL])
    )
  ).toEqual({ lastSeq: 10 });
  expect(runRow(runId)).toMatchObject({
    error: "Stopped after 5 identical failed calls to read_file in a row",
    status: "failed",
  });
  // The run's own events have no seq, so they are read in insertion order.
  expect(
    runEvents(runId)
      .map((event) => event.type)
      .filter((type) => type.startsWith("run."))
      .slice(-2)
  ).toEqual(["run.repeat_stopped", "run.failed"]);
  expect(payloadOf(runId, "run.repeat_stopped")).toMatchObject({
    count: 5,
    tool: "read_file",
  });
  expect(cancelled).toEqual([runId]);
});

test("four identical failed calls leave the run running and cancel nothing", async () => {
  const cancelled: string[] = [];
  runs = buildRuns({ adapters: [cancellingAdapter(cancelled)] });
  const runId = await claimedRun();
  await runs.ingestRunEvents(
    SYSTEM_PRINCIPAL,
    runId,
    rounds(1, [FAIL, FAIL, FAIL, FAIL])
  );
  expect(runRow(runId)).toMatchObject({ status: "running" });
  expect(cancelled).toEqual([]);
});

test("a different input in the middle of the streak resets the count", async () => {
  const cancelled: string[] = [];
  runs = buildRuns({ adapters: [cancellingAdapter(cancelled)] });
  const runId = await claimedRun();
  await runs.ingestRunEvents(
    SYSTEM_PRINCIPAL,
    runId,
    rounds(1, [FAIL, FAIL, OTHER_FAIL, FAIL, FAIL])
  );
  expect(runRow(runId)).toMatchObject({ status: "running" });
  expect(cancelled).toEqual([]);
});

test("a successful call in the middle of the streak resets the count", async () => {
  const cancelled: string[] = [];
  runs = buildRuns({ adapters: [cancellingAdapter(cancelled)] });
  const runId = await claimedRun();
  await runs.ingestRunEvents(
    SYSTEM_PRINCIPAL,
    runId,
    rounds(1, [FAIL, FAIL, OK, FAIL, FAIL])
  );
  expect(runRow(runId)).toMatchObject({ status: "running" });
  expect(cancelled).toEqual([]);
});

test("a streak that spans two batches stops on the second", async () => {
  const cancelled: string[] = [];
  runs = buildRuns({ adapters: [cancellingAdapter(cancelled)] });
  const runId = await claimedRun();
  await runs.ingestRunEvents(
    SYSTEM_PRINCIPAL,
    runId,
    rounds(1, [FAIL, FAIL, FAIL])
  );
  expect(runRow(runId)).toMatchObject({ status: "running" });
  expect(cancelled).toEqual([]);

  await runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, rounds(7, [FAIL, FAIL]));
  expect(runRow(runId)).toMatchObject({
    error: "Stopped after 5 identical failed calls to read_file in a row",
    status: "failed",
  });
  expect(cancelled).toEqual([runId]);
});

test("a cloud run is not stopped by the service after five identical failed calls", async () => {
  const cancelled: string[] = [];
  runs = buildRuns({
    adapters: [{ ...cancellingAdapter(cancelled), kind: "cloud" }],
  });
  const cloudAgentId = (
    await agents.create(user, {
      model: "sonnet",
      name: "Cloud",
      runtime: "cloud",
    })
  ).id;
  const runId = await claimedRun(cloudAgentId);
  await runs.ingestRunEvents(
    SYSTEM_PRINCIPAL,
    runId,
    rounds(1, [FAIL, FAIL, FAIL, FAIL, FAIL])
  );
  expect(runRow(runId)).toMatchObject({ status: "running" });
  expect(cancelled).toEqual([]);
});

test("an ingest after a repeat stop is refused as the run is no longer running", async () => {
  runs = buildRuns({ adapters: [cancellingAdapter([])] });
  const runId = await claimedRun();
  await runs.ingestRunEvents(
    SYSTEM_PRINCIPAL,
    runId,
    rounds(1, [FAIL, FAIL, FAIL, FAIL, FAIL])
  );
  const error = await failure(
    runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, rounds(11, [OK]))
  );
  expect(error).toMatchObject({ code: "conflict" });
});

test("a repeat stop offers the agent's next waiting run when the runtime offers on end", async () => {
  const offering: RuntimeAdapter = {
    ...cancellingAdapter([]),
    offerNextOnEnd: true,
  };
  runs = buildRuns({ adapters: [offering] });
  const runId = await claimedRun();
  const waiting = await start(user, spyAgentId);
  dispatched = [];

  await runs.ingestRunEvents(
    SYSTEM_PRINCIPAL,
    runId,
    rounds(1, [FAIL, FAIL, FAIL, FAIL, FAIL])
  );
  expect(runRow(runId)).toMatchObject({ status: "failed" });
  expect(dispatched).toEqual([waiting.runId]);
});

test("onEvent listeners hear the run events, each with the run's id", async () => {
  const heard: EventRecord[] = [];
  runs.onEvent((event) => {
    heard.push(event);
    return Promise.resolve();
  });
  const { runId } = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, [
    {
      payload: { input: {}, name: "bash", toolUseId: "t1" },
      seq: 1,
      type: "tool.call",
    },
  ]);
  await runs.completeRun(SYSTEM_PRINCIPAL, runId, {
    error: "boom",
    status: "failed",
  });

  const types = heard.map((event) => event.type);
  expect(types).toEqual([
    "run.queued",
    "message.user",
    "run.started",
    "tool.call",
    "run.failed",
  ]);
  for (const event of heard) {
    expect(event.runId).toBe(runId);
  }
  expect(heard[3]).toMatchObject({
    payload: { input: {}, name: "bash", toolUseId: "t1" },
    seq: 1,
  });
});

test("onEvent listeners hear the run.queued and message.user of an offerLater start", async () => {
  const heard: EventRecord[] = [];
  runs.onEvent((event) => {
    heard.push(event);
    return Promise.resolve();
  });
  const { runId } = await start(user, spyAgentId, {}, "hello", {
    offerLater: true,
  });

  expect(heard.map((event) => event.type)).toEqual([
    "run.queued",
    "message.user",
  ]);
  for (const event of heard) {
    expect(event.runId).toBe(runId);
  }
  expect(heard[1]?.payload).toMatchObject({ text: "hello" });
});

test("onEvent listeners hear run.cancelled for a queued run and for a running one", async () => {
  const heard: EventRecord[] = [];
  runs.onEvent((event) => {
    heard.push(event);
    return Promise.resolve();
  });
  const queued = await start(user, spyAgentId);
  await runs.cancelRun(user, queued.runId);
  const running = await start(user, await addSpyAgent());
  await runs.claimRun(SYSTEM_PRINCIPAL, running.runId);
  await runs.cancelRun(user, running.runId);

  for (const runId of [queued.runId, running.runId]) {
    const cancelled = heard.filter(
      (event) => event.runId === runId && event.type === "run.cancelled"
    );
    expect(cancelled).toHaveLength(1);
  }
});

test("a throwing onEvent listener does not fail completeRun or cancelRun", async () => {
  const logged = spyOn(console, "error").mockImplementation(() => undefined);
  runs.onEvent(() => {
    throw new Error("boom");
  });

  const done = await start(user, spyAgentId);
  await runs.claimRun(SYSTEM_PRINCIPAL, done.runId);
  await runs.completeRun(SYSTEM_PRINCIPAL, done.runId, {
    error: "boom",
    status: "failed",
  });
  expect(runRow(done.runId)).toMatchObject({ status: "failed" });

  const cancelled = await start(user, spyAgentId);
  await runs.cancelRun(user, cancelled.runId);
  expect(runRow(cancelled.runId)).toMatchObject({ status: "cancelled" });

  expect(logged).toHaveBeenCalledWith(
    "Event listener failed",
    expect.any(Error)
  );
  logged.mockRestore();
});
