import { beforeEach, expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { inboxThreads } from "@repo/db/schema/inbox";
import { machines as machineRows } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { triggers as triggerRows } from "@repo/db/schema/triggers";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import {
  APPROVAL_TTL_MS,
  type EventType,
  type RunStatus,
} from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { createMasker } from "@repo/protocol/masker";
import { type AgentsService, createAgentsService } from "../agents.ts";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import { createEventsService, type PeopleLookup } from "../events.ts";
import { createRequestsService, type RequestsService } from "../requests.ts";
import type { Clock, RuntimeAdapter } from "../runs/types.ts";
import { createRunsService, type RunsService } from "../runs.ts";
import { type Principal, SYSTEM_PRINCIPAL as system } from "../workspaces.ts";
import { createTasksService, type TasksService } from "./service.ts";

const user = (userId = "u1", workspaceId = "w1"): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});
const runPrincipal = (agentId: string, runId: string): Principal => ({
  agentId,
  kind: "run",
  runId,
  workspaceId: "w1",
});
const triggerPrincipal = (triggerId: string, agentId: string): Principal => ({
  agentId,
  kind: "trigger",
  triggerId,
  workspaceId: "w1",
});

const NOW = Date.parse("2026-10-26T09:00:00Z");
const ISO_NOW = new Date(NOW).toISOString();

/** Every event type a task view shows in these tests. */
const SHOWN: EventType[] = [
  "message.user",
  "message.assistant",
  "tool.call",
  "tool.result",
  "request.opened",
  "request.answered",
  "request.expired",
  "request.cancelled",
];

let db: ReturnType<typeof migrated>;
let now: number;
let clock: Clock;
let agents: AgentsService;
let events: ReturnType<typeof createEventsService>;
let requests: RequestsService;
let runs: RunsService;
let tasks: TasksService;
let a1: string;
let a2: string;
let b1: string;
let approvalCalls: number;

const buildTasks = (people?: PeopleLookup): TasksService =>
  createTasksService({
    clock,
    db,
    events,
    eventTypes: SHOWN,
    people,
    requests,
  });

beforeEach(async () => {
  db = migrated();
  now = NOW;
  approvalCalls = 0;
  clock = {
    now: () => new Date(now),
    sleep: () => Promise.resolve(),
  };
  const iso = ISO_NOW;
  await db.insert(workspaceRows).values(
    ["w1", "w2"].map((id) => ({
      clerkOrgId: `org_${id}`,
      createdAt: iso,
      id,
      name: id,
      timezone: "UTC",
    }))
  );
  const blobs = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
  };
  const atomic = sqliteAtomic(db);
  events = createEventsService({ blobs, db });
  const adapter: RuntimeAdapter = {
    cancel: () => Promise.resolve(),
    dispatch: () => Promise.resolve(),
    kind: "cloud",
    resume: () => Promise.resolve(),
  };
  runs = createRunsService({
    adapters: [adapter],
    atomic,
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
  });
  requests = createRequestsService({
    atomic,
    clock,
    db,
    events,
    runs,
    secrets: {
      maskerFor: () =>
        Promise.resolve(createMasker({ NAME: "granted-value-123" })),
    },
  });
  agents = createAgentsService({ db, events });
  const make = async (name: string, workspaceId: string) =>
    (
      await agents.create(user("u1", workspaceId), {
        model: "m",
        name,
        runtime: "cloud",
      })
    ).id;
  a1 = await make("Alpha", "w1");
  a2 = await make("Beta", "w1");
  b1 = await make("Other", "w2");
  tasks = buildTasks();
});

interface SeedSession {
  actorId?: string;
  actorKind?: string;
  agentId?: string;
  externalKey?: string;
  id: string;
  origin?: string;
  private?: boolean;
  runtimeMachineId?: string;
  workspaceId?: string;
}

/** A session row, inserted directly so its origin and visibility are exact. */
const seedSession = async (o: SeedSession): Promise<string> => {
  await db.insert(sessionRows).values({
    actorId: o.actorId ?? "u1",
    actorKind: o.actorKind ?? "user",
    agentId: o.agentId ?? a1,
    createdAt: ISO_NOW,
    externalKey: o.externalKey ?? null,
    id: o.id,
    origin: o.origin ?? "ui",
    private: o.private ?? false,
    runtimeMachineId: o.runtimeMachineId ?? null,
    workspaceId: o.workspaceId ?? "w1",
  });
  return o.id;
};

interface SeedRun {
  actorId?: string;
  actorKind?: string;
  agentId?: string;
  error?: string;
  id: string;
  inputText?: string;
  parentRunId?: string;
  resultText?: string;
  sessionId: string;
  status: RunStatus;
  usage?: string;
  workspaceId?: string;
}

/** A run row in an existing session, inserted directly. */
const seedRun = async (o: SeedRun): Promise<string> => {
  await db.insert(runRows).values({
    actorId: o.actorId ?? "u1",
    actorKind: o.actorKind ?? "user",
    agentId: o.agentId ?? a1,
    createdAt: ISO_NOW,
    error: o.error ?? null,
    id: o.id,
    inputText: o.inputText ?? `Task ${o.id}`,
    parentRunId: o.parentRunId ?? null,
    resultText: o.resultText ?? null,
    sessionId: o.sessionId,
    status: o.status,
    usage: o.usage ?? null,
    workspaceId: o.workspaceId ?? "w1",
  });
  return o.id;
};

/** A run in its own ui session, so the list has one row per run. */
const seedTask = async (
  id: string,
  o: Omit<SeedRun, "id" | "sessionId"> = { status: "queued" }
): Promise<string> => {
  const sessionId = await seedSession({
    agentId: o.agentId,
    id: `s-${id}`,
    workspaceId: o.workspaceId,
  });
  return await seedRun({ ...o, id, sessionId });
};

const seedEvent = (
  id: string,
  sessionId: string,
  runId: string,
  type: EventType,
  payload: Record<string, unknown> = {}
) =>
  db.insert(eventRows).values({
    actorId: "agent",
    actorKind: "agent",
    agentId: a1,
    createdAt: ISO_NOW,
    id,
    payload: JSON.stringify(payload),
    runId,
    sessionId,
    type,
    workspaceId: "w1",
  });

const insertTrigger = (
  id: string,
  kind: "http" | "routine",
  name: string,
  agentId = a1
) =>
  db.insert(triggerRows).values({
    agentId,
    createdAt: ISO_NOW,
    createdBy: "u1",
    id,
    kind,
    name,
    workspaceId: "w1",
  });

/** A real run that waits on an approval, as a person's chat would leave it. */
const waitingOnApproval = async (agentId = a1) => {
  const run = await runs.startRun(user(), {
    agentId,
    input: { text: "deploy the thing" },
    session: { origin: "ui" },
  });
  await runs.claimRun(system, run.runId);
  approvalCalls += 1;
  const request = await requests.open(system, {
    input: { command: "rm -rf build" },
    kind: "approval",
    runId: run.runId,
    toolKey: "bash",
    toolName: "bash",
    toolUseId: `call-${approvalCalls}`,
  });
  return { requestId: request.id, runId: run.runId, sessionId: run.sessionId };
};

const errorOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (caught: unknown) => caught
  );

test("a ui run started by a user is labelled with the person's name", async () => {
  const people: PeopleLookup = (ids) =>
    Promise.resolve(
      new Map(ids.map((id) => [id, { email: null, name: "Ada Lovelace" }]))
    );
  const started = await runs.startRun(user(), {
    agentId: a1,
    input: { text: "hello" },
    session: { origin: "ui" },
  });

  const view = await buildTasks(people).get(user(), { runId: started.runId });

  expect(view.startedBy).toEqual({
    kind: "person",
    label: "Ada Lovelace",
  });
});

test("a ui run is labelled A teammate without a people lookup, or when the lookup throws", async () => {
  const started = await runs.startRun(user(), {
    agentId: a1,
    input: { text: "hello" },
    session: { origin: "ui" },
  });
  const failing: PeopleLookup = () => Promise.reject(new Error("down"));
  const logged = spyOn(console, "error").mockImplementation(() => undefined);

  try {
    const plain = await buildTasks().get(user(), { runId: started.runId });
    const broken = await buildTasks(failing).get(user(), {
      runId: started.runId,
    });

    expect(plain.startedBy).toEqual({ kind: "person", label: "A teammate" });
    expect(broken.startedBy).toEqual({ kind: "person", label: "A teammate" });
  } finally {
    logged.mockRestore();
  }
});

test("a Slack run is labelled Slack", async () => {
  const started = await runs.startRun(user(), {
    agentId: a1,
    input: { text: "from slack" },
    session: { externalKey: "C1-thread", origin: "slack" },
  });

  const view = await tasks.get(user(), { runId: started.runId });

  expect(view.startedBy).toEqual({ kind: "slack", label: "Slack" });
});

test("an inbox run is labelled with its thread's title", async () => {
  await db.insert(inboxThreads).values({
    createdAt: ISO_NOW,
    createdBy: "u1",
    id: "thr-1",
    lastPostAt: ISO_NOW,
    title: "Quarterly review",
    workspaceId: "w1",
  });
  const started = await runs.startRun(user(), {
    agentId: a1,
    input: { text: "draft the agenda" },
    session: { externalKey: "thr-1", origin: "inbox" },
  });

  const view = await tasks.get(user(), { runId: started.runId });

  expect(view.startedBy).toEqual({
    kind: "inbox",
    label: "Inbox thread: Quarterly review",
  });
});

test("a routine run is labelled with the routine's name", async () => {
  await insertTrigger("trg-digest", "routine", "Daily digest");
  const started = await runs.startRun(triggerPrincipal("trg-digest", a1), {
    agentId: a1,
    input: { text: "summarise the day" },
    session: { origin: "trigger" },
  });

  const view = await tasks.get(user(), { runId: started.runId });

  expect(view.startedBy).toEqual({
    kind: "routine",
    label: "Routine: Daily digest",
  });
});

test("an http trigger run is labelled as a trigger with its name", async () => {
  await insertTrigger("trg-deploy", "http", "Deploy hook");
  const started = await runs.startRun(triggerPrincipal("trg-deploy", a1), {
    agentId: a1,
    input: { text: "build the site" },
    session: { origin: "trigger" },
  });

  const view = await tasks.get(user(), { runId: started.runId });

  expect(view.startedBy).toEqual({
    kind: "trigger",
    label: "Trigger: Deploy hook",
  });
});

test("a run another run started is a handoff, naming the parent's agent and run", async () => {
  const parentSession = await seedSession({ agentId: a1, id: "s-parent" });
  await seedRun({
    agentId: a1,
    id: "run-parent",
    sessionId: parentSession,
    status: "done",
  });
  const childSession = await seedSession({ agentId: a2, id: "s-child" });
  await seedRun({
    agentId: a2,
    id: "run-child",
    parentRunId: "run-parent",
    sessionId: childSession,
    status: "queued",
  });

  const view = await tasks.get(user(), { runId: "run-child" });

  expect(view.startedBy).toEqual({
    kind: "handoff",
    label: "Handoff from Alpha",
    parentRunId: "run-parent",
  });
});

test("a run's cost is the usage's costUsd", async () => {
  await seedTask("run-cost", {
    status: "done",
    usage: JSON.stringify({ costUsd: 0.42 }),
  });

  const view = await tasks.get(user(), { runId: "run-cost" });

  expect(view.run.costUsd).toBe(0.42);
});

test("a run with no usage, or usage without costUsd, has a null cost, not zero", async () => {
  await seedTask("run-none", { status: "done" });
  await seedTask("run-tokens", {
    status: "done",
    usage: JSON.stringify({ inputTokens: 10 }),
  });

  const none = await tasks.get(user(), { runId: "run-none" });
  const tokens = await tasks.get(user(), { runId: "run-tokens" });

  expect(none.run.costUsd).toBeNull();
  expect(tokens.run.costUsd).toBeNull();
});

test("get returns the run, its agent, its session and the session's other runs, oldest first", async () => {
  const session = await seedSession({
    externalKey: "ext-1",
    id: "s-main",
    origin: "ui",
  });
  await seedRun({ id: "run-01", sessionId: session, status: "done" });
  await seedRun({
    id: "run-02",
    inputText: "second",
    sessionId: session,
    status: "queued",
  });
  await seedRun({
    id: "run-03",
    inputText: "third",
    sessionId: session,
    status: "running",
  });

  const view = await tasks.get(user(), { runId: "run-02" });

  expect(view.run).toMatchObject({ id: "run-02", inputText: "second" });
  expect(view.otherRuns).toEqual([
    {
      createdAt: ISO_NOW,
      id: "run-01",
      inputText: "Task run-01",
      status: "done",
    },
    { createdAt: ISO_NOW, id: "run-03", inputText: "third", status: "running" },
  ]);
  expect(view.agent).toEqual({
    id: a1,
    machine: null,
    name: "Alpha",
    runtime: "cloud",
  });
  expect(view.session).toEqual({
    externalKey: "ext-1",
    id: "s-main",
    origin: "ui",
  });
});

test("get names the machine of a session that runs on one", async () => {
  await db.insert(machineRows).values({
    capabilities: "{}",
    createdAt: ISO_NOW,
    credentialHash: "hash-laptop",
    enrolledBy: "u1",
    id: "mach-1",
    name: "laptop",
    singleUser: false,
    status: "online",
    workspaceId: "w1",
  });
  const session = await seedSession({
    id: "s-machine",
    runtimeMachineId: "mach-1",
  });
  await seedRun({ id: "run-machine", sessionId: session, status: "queued" });

  const view = await tasks.get(user(), { runId: "run-machine" });

  expect(view.agent.machine).toEqual({ id: "mach-1", name: "laptop" });
});

test("get returns the events of every run in the session, oldest first, with the listed types only", async () => {
  const session = await seedSession({ id: "s-events" });
  await seedRun({ id: "run-e1", sessionId: session, status: "done" });
  await seedRun({ id: "run-e2", sessionId: session, status: "waiting" });
  await seedEvent("ev-001", session, "run-e1", "message.user", { text: "one" });
  await seedEvent("ev-002", session, "run-e1", "tool.call", {
    input: {},
    name: "web_search",
    toolUseId: "t1",
  });
  await seedEvent("ev-003", session, "run-e1", "run.queued", {
    origin: "ui",
  });
  await seedEvent("ev-004", session, "run-e2", "message.user", { text: "two" });
  await seedEvent("ev-005", session, "run-e2", "message.assistant", {
    text: "done",
  });

  const view = await tasks.get(user(), { runId: "run-e1" });

  expect(view.events.map((event) => event.id)).toEqual([
    "ev-001",
    "ev-002",
    "ev-004",
    "ev-005",
  ]);
  expect(view.eventsTruncated).toBe(false);
});

test("get returns the open request of the run, with the request id", async () => {
  const { requestId, runId } = await waitingOnApproval();

  const view = await tasks.get(user(), { runId });

  expect(view.request?.id).toBe(requestId);
  expect(view.run.status).toBe("waiting");
});

test("get returns a null request once the open request has expired", async () => {
  const { runId } = await waitingOnApproval();
  now += APPROVAL_TTL_MS + 1;

  const view = await tasks.get(user(), { runId });

  expect(view.request).toBeNull();
});

test("get returns a null request for a run with no request", async () => {
  const started = await runs.startRun(user(), {
    agentId: a1,
    input: { text: "no approvals here" },
    session: { origin: "ui" },
  });

  const view = await tasks.get(user(), { runId: started.runId });

  expect(view.request).toBeNull();
});

test("a ui session opened by one user is not visible to another, in get and list", async () => {
  const started = await runs.startRun(user("u1"), {
    agentId: a1,
    input: { text: "mine" },
    session: { origin: "ui" },
  });

  const error = await errorOf(tasks.get(user("u2"), { runId: started.runId }));
  const unknown = await errorOf(
    tasks.get(user("u2"), { runId: "no-such-run" })
  );
  const listed = await tasks.list(user("u2"), { limit: 10 });

  expect(error).toBeInstanceOf(ServiceError);
  expect(error).toMatchObject({ code: "not_found", message: "Task not found" });
  expect(unknown).toMatchObject({
    code: "not_found",
    message: "Task not found",
  });
  expect(listed.map((item) => item.id)).not.toContain(started.runId);
});

test("a private Slack DM is visible only to the user who opened it, in get and list", async () => {
  const session = await seedSession({
    id: "s-dm",
    origin: "slack",
    private: true,
  });
  await seedRun({ id: "run-dm", sessionId: session, status: "done" });

  const error = await errorOf(tasks.get(user("u2"), { runId: "run-dm" }));
  const listed = await tasks.list(user("u2"), { limit: 10 });
  const own = await tasks.get(user("u1"), { runId: "run-dm" });

  expect(error).toMatchObject({ code: "not_found", message: "Task not found" });
  expect(listed.map((item) => item.id)).not.toContain("run-dm");
  expect(own.run.id).toBe("run-dm");
});

test("a trigger run is visible to every member of the workspace, in get and list", async () => {
  await insertTrigger("trg-shared", "http", "Shared hook");
  const started = await runs.startRun(triggerPrincipal("trg-shared", a1), {
    agentId: a1,
    input: { text: "for everyone" },
    session: { origin: "trigger" },
  });

  const second = await tasks.get(user("u2"), { runId: started.runId });
  const listed = await tasks.list(user("u2"), { limit: 10 });

  expect(second.run.id).toBe(started.runId);
  expect(listed.map((item) => item.id)).toContain(started.runId);
});

test("list returns runs newest first", async () => {
  await seedTask("run-01");
  await seedTask("run-02");
  await seedTask("run-03");

  const items = await tasks.list(user(), { limit: 10 });

  expect(items.map((item) => item.id)).toEqual(["run-03", "run-02", "run-01"]);
});

test("list filters by agent", async () => {
  await seedTask("run-a1", { agentId: a1, status: "queued" });
  await seedTask("run-a2", { agentId: a2, status: "queued" });

  const items = await tasks.list(user(), { agentId: a1, limit: 10 });

  expect(items.map((item) => item.id)).toEqual(["run-a1"]);
});

test("list returns at most limit runs", async () => {
  await Promise.all([1, 2, 3, 4, 5].map((n) => seedTask(`run-0${n}`)));

  const items = await tasks.list(user(), { limit: 2 });

  expect(items).toHaveLength(2);
});

test("list pages with before, the last run id of the previous page, with no overlap", async () => {
  await Promise.all([1, 2, 3, 4, 5].map((n) => seedTask(`run-0${n}`)));

  const first = await tasks.list(user(), { limit: 2 });
  const lastId = first.map((item) => item.id).pop() ?? "";
  const second = await tasks.list(user(), { before: lastId, limit: 2 });
  const third = await tasks.list(user(), {
    before: second.map((item) => item.id).pop() ?? "",
    limit: 2,
  });

  expect(first.map((item) => item.id)).toEqual(["run-05", "run-04"]);
  expect(second.map((item) => item.id)).toEqual(["run-03", "run-02"]);
  expect(third.map((item) => item.id)).toEqual(["run-01"]);
});

test("list titles a ui run with its trimmed input", async () => {
  await runs.startRun(user(), {
    agentId: a1,
    input: { text: "  Plan the offsite  " },
    session: { origin: "ui" },
  });

  const [item] = await tasks.list(user(), { limit: 10 });

  expect(item?.title).toBe("Plan the offsite");
});

test("list titles a routine run with the routine's name", async () => {
  await insertTrigger("trg-weekly", "routine", "Weekly report");
  await runs.startRun(triggerPrincipal("trg-weekly", a1), {
    agentId: a1,
    input: { text: "build the report" },
    session: { origin: "trigger" },
  });

  const [item] = await tasks.list(user(), { limit: 10 });

  expect(item?.title).toBe("Weekly report");
});

test("list gives each run its status band: done, failed, queued and waiting", async () => {
  await seedTask("run-done", {
    resultText: "All sorted. More detail.",
    status: "done",
  });
  await seedTask("run-failed", { error: "Tool crashed.", status: "failed" });
  await seedTask("run-queued", { status: "queued" });
  const waiting = await waitingOnApproval();

  const items = await tasks.list(user(), { limit: 10 });
  const band = (id: string) => items.find((item) => item.id === id)?.statusBand;

  expect(band("run-done")).toEqual({ text: "All sorted.", tone: "ok" });
  expect(band("run-failed")).toEqual({ text: "Tool crashed.", tone: "error" });
  expect(band("run-queued")).toEqual({
    text: "Waiting to start",
    tone: "waiting",
  });
  expect(band(waiting.runId)?.text.startsWith("Waiting for approval")).toBe(
    true
  );
  expect(band(waiting.runId)?.tone).toBe("waiting");
});

test("a user of workspace w2 cannot get a w1 run, and list returns only w2 runs", async () => {
  await seedTask("run-w1", { status: "queued" });
  await seedTask("run-w2", {
    agentId: b1,
    status: "queued",
    workspaceId: "w2",
  });

  const error = await errorOf(tasks.get(user("u1", "w2"), { runId: "run-w1" }));
  const listed = await buildTasks().list(user("u1", "w2"), { limit: 10 });

  expect(error).toMatchObject({ code: "not_found", message: "Task not found" });
  expect(listed.map((item) => item.id)).toEqual(["run-w2"]);
});

test("run and system principals are refused by get and list", async () => {
  await seedTask("run-x", { status: "queued" });
  const principals: Principal[] = [runPrincipal(a1, "run-x"), system];

  const refusals = await Promise.all(
    principals.map((principal) =>
      Promise.all([
        errorOf(tasks.get(principal, { runId: "run-x" })),
        errorOf(tasks.list(principal, { limit: 10 })),
      ])
    )
  );

  for (const [got, listed] of refusals) {
    expect(got).toBeInstanceOf(ForbiddenError);
    expect(listed).toBeInstanceOf(ForbiddenError);
  }
});

test("list rejects a limit below 1 or above 100", async () => {
  const low = await errorOf(tasks.list(user(), { limit: 0 }));
  const high = await errorOf(tasks.list(user(), { limit: 101 }));

  expect(low).toBeDefined();
  expect(high).toBeDefined();
});

test("get rejects an empty run id", async () => {
  const error = await errorOf(tasks.get(user(), { runId: "" }));

  expect(error).toBeDefined();
});
