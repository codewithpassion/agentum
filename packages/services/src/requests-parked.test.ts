import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { machines } from "@repo/db/schema/machines";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createAgentsService } from "./agents.ts";
import { createEventsService } from "./events.ts";
import { createMachineRuntime } from "./machines/runtime.ts";
import { noopRelay } from "./machines/types.ts";
import { createRequestsService, type RequestsService } from "./requests.ts";
import type { Clock } from "./runs/types.ts";
import { createRunsService, type RunsService } from "./runs.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const PLATFORM = "https://hm.example/";
const QUESTION = "Which colour?";

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const machine: Principal = {
  kind: "machine",
  machineId: "m1",
  workspaceId: WORKSPACE,
};

let db: ReturnType<typeof migrated>;
let nowMs: number;
let runs: RunsService;
let requests: RequestsService;
let agentId: string;

const clock: Clock = {
  now: () => new Date(nowMs),
  sleep: () => Promise.resolve(),
};

const run = (id: string) =>
  db.select().from(runRows).where(eq(runRows.id, id)).get();
const sessionRuns = (sessionId: string) =>
  db.select().from(runRows).where(eq(runRows.sessionId, sessionId)).all();

const startRun = async (text = "hi") => {
  nowMs += 1000;
  return await runs.startRun(user, {
    agentId,
    input: { text },
    session: { origin: "ui" },
  });
};
const claim = (runId: string) =>
  runs.claimRunForMachine(machine, runId, {
    platformUrl: PLATFORM,
    questionsLaterForDaemon: true,
    requestsForDaemon: true,
  });
const ask = (runId: string) =>
  requests.open(machine, {
    kind: "question",
    questions: [{ question: QUESTION }],
    runId,
    toolName: "AskUserQuestion",
    toolUseId: "ask1",
  });
/** The daemon's last act: its turn ended on the question. */
const endTurn = (runId: string) =>
  runs.completeRun(machine, runId, {
    awaitingAnswer: true,
    runtimeRef: "claude-session",
    status: "done",
    text: "I asked you.",
  });
const answer = (
  requestId: string,
  text = "Blue",
  via: "slack" | "web" = "web"
) =>
  requests.answer(user, {
    answer: { answers: { [QUESTION]: text } },
    requestId,
    via,
  });

beforeEach(async () => {
  db = migrated();
  nowMs = Date.parse(START);
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: START,
      id: WORKSPACE,
      name: "w1",
      timezone: "UTC",
    })
    .run();
  db.insert(machines)
    .values({
      capabilities: "{}",
      createdAt: START,
      credentialHash: "m1",
      enrolledBy: "u1",
      id: "m1",
      lastSeenAt: null,
      name: "m1",
      singleUser: false,
      status: "online",
      workspaceId: WORKSPACE,
    })
    .run();
  const store = new Map<string, string>();
  const blobs = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, body: string) => {
      store.set(key, body);
      return Promise.resolve();
    },
  };
  const events = createEventsService({ blobs, db });
  const agents = createAgentsService({ db, events });
  agentId = (
    await agents.create(user, {
      machineId: "m1",
      model: "m",
      name: "Box",
      runtime: "machine",
    })
  ).id;
  runs = createRunsService({
    adapters: [createMachineRuntime({ relay: noopRelay })],
    atomic: sqliteAtomic(db),
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
    runTokenKey: KEY,
  });
  requests = createRequestsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    runs,
    secrets: { maskerFor: () => Promise.resolve(null) },
  });
});

test("a claim carries questionsLater only for a daemon that asks for it", async () => {
  const first = await startRun();
  expect((await claim(first.runId)).questionsLater).toBe(true);
  const second = await startRun();
  await runs.completeRun(machine, first.runId, { status: "done" });
  const plain = await runs.claimRunForMachine(machine, second.runId, {
    platformUrl: PLATFORM,
    requestsForDaemon: true,
  });
  expect(plain.questionsLater).toBeUndefined();
});

test("a plain machine run defers its question", async () => {
  const started = await startRun();
  await claim(started.runId);
  await ask(started.runId);
  expect(await requests.defersQuestion(machine, started.runId)).toBe(true);
});

test("a parked question frees the agent for another run, and the answer starts exactly one follow-up in the same session", async () => {
  const first = await startRun("first task");
  await claim(first.runId);
  const opened = await ask(first.runId);
  expect(run(first.runId)?.status).toBe("waiting");

  // The daemon ends the turn: the run parks, no lease, no finish.
  await endTurn(first.runId);
  const parked = run(first.runId);
  expect(parked?.status).toBe("waiting");
  expect(parked?.leaseUntil).toBeNull();
  expect(parked?.finishedAt).toBeNull();

  // The agent takes a second task meanwhile.
  const second = await startRun("second task");
  await claim(second.runId);
  expect(run(second.runId)?.status).toBe("running");
  await runs.completeRun(machine, second.runId, { status: "done" });

  // The answer ends the parked run and starts one follow-up in its session.
  await answer(opened.id);
  expect(run(first.runId)?.status).toBe("done");
  const followUps = sessionRuns(first.sessionId).filter(
    (row) => row.id !== first.runId
  );
  expect(followUps).toHaveLength(1);
  const [followUp] = followUps;
  expect(followUp?.status).toBe("offered");
  expect(followUp?.inputText).toContain("Q: Which colour? A: Blue");
  expect(followUp?.depth).toBe(parked?.depth ?? -1);
  expect(followUp?.parentRunId).toBeNull();

  // The follow-up resumes the stored Claude session.
  const claimed = await claim(followUp?.id ?? "");
  expect(claimed.session.runtimeRef).toBe("claude-session");

  // A second answer is refused and starts nothing.
  await expect(answer(opened.id, "Red")).rejects.toThrow("Already answered");
  expect(
    sessionRuns(first.sessionId).filter((row) => row.id !== first.runId)
  ).toHaveLength(1);
});

test("an answer from Slack wakes the session once too", async () => {
  const started = await startRun();
  await claim(started.runId);
  const opened = await ask(started.runId);
  await endTurn(started.runId);
  await answer(opened.id, "Green", "slack");
  expect(
    sessionRuns(started.sessionId).filter((row) => row.id !== started.runId)
  ).toHaveLength(1);
});

test("an answer that lands before the turn ends still wakes the session once", async () => {
  const started = await startRun();
  await claim(started.runId);
  const opened = await ask(started.runId);
  await answer(opened.id);
  expect(
    sessionRuns(started.sessionId).filter((row) => row.id !== started.runId)
  ).toHaveLength(0);
  await endTurn(started.runId);
  expect(run(started.runId)?.status).toBe("done");
  const followUps = sessionRuns(started.sessionId).filter(
    (row) => row.id !== started.runId
  );
  expect(followUps).toHaveLength(1);
  expect(followUps[0]?.inputText).toContain("A: Blue");
});

test("a question that expires wakes the session with the time-out line", async () => {
  const started = await startRun();
  await claim(started.runId);
  await ask(started.runId);
  await endTurn(started.runId);
  nowMs += 25 * 60 * 60 * 1000;
  await requests.expireDue({ kind: "system" });
  const followUps = sessionRuns(started.sessionId).filter(
    (row) => row.id !== started.runId
  );
  expect(followUps).toHaveLength(1);
  expect(followUps[0]?.inputText).toContain("Nobody answered the question");
});

test("two open questions wake the session once, after the last one closes", async () => {
  const started = await startRun();
  await claim(started.runId);
  const first = await ask(started.runId);
  const second = await requests.open(machine, {
    kind: "question",
    questions: [{ question: "Which size?" }],
    runId: started.runId,
    toolName: "AskUserQuestion",
    toolUseId: "ask2",
  });
  await endTurn(started.runId);
  await answer(first.id);
  expect(run(started.runId)?.status).toBe("waiting");
  await requests.answer(user, {
    answer: { answers: { "Which size?": "Large" } },
    requestId: second.id,
    via: "web",
  });
  expect(run(started.runId)?.status).toBe("done");
  const followUps = sessionRuns(started.sessionId).filter(
    (row) => row.id !== started.runId
  );
  expect(followUps).toHaveLength(1);
  expect(followUps[0]?.inputText).toContain("Q: Which colour? A: Blue");
  expect(followUps[0]?.inputText).toContain("Q: Which size? A: Large");
});

test("cancelling a parked run withdraws its question and starts nothing", async () => {
  const started = await startRun();
  await claim(started.runId);
  const opened = await ask(started.runId);
  await endTurn(started.runId);
  await runs.cancelRun(user, started.runId);
  expect(run(started.runId)?.status).toBe("cancelled");
  const row = db
    .select()
    .from(runRequests)
    .where(eq(runRequests.id, opened.id))
    .get();
  expect(row?.status).toBe("cancelled");
  expect(sessionRuns(started.sessionId)).toHaveLength(1);
  expect(
    db.select().from(sessions).where(eq(sessions.id, started.sessionId)).get()
  ).toBeDefined();
});

test("a parked run is not reaped for its missing lease", async () => {
  const started = await startRun();
  await claim(started.runId);
  await ask(started.runId);
  await endTurn(started.runId);
  nowMs += 60 * 60 * 1000;
  await runs.reapExpiredLeases({ kind: "system" });
  expect(run(started.runId)?.status).toBe("waiting");
});
