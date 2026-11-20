import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { machines } from "@repo/db/schema/machines";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createMasker } from "@repo/protocol/masker";
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
let delivered: string[];
let masker: ReturnType<typeof createMasker> | null;

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
beforeEach(async () => {
  db = migrated();
  delivered = [];
  masker = null;
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
    gateways: [
      {
        deliver: (_target, message) => {
          delivered.push(message.text);
          return Promise.resolve();
        },
        kind: "none",
      },
    ],
    runTokenKey: KEY,
  });
  requests = createRequestsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    runs,
    secrets: { maskerFor: () => Promise.resolve(masker) },
  });
});

const QUESTIONS = [
  { options: ["Blue", "Red"], text: "Which colour?" },
  { freeText: true, options: ["Small", "Large"], text: "Which size?" },
  { options: ["Now", "Later"], text: "When?" },
];
const raise = (runId: string, questions = QUESTIONS) =>
  requests.openDecisions(machine, { questions, runId });
const answerSome = (
  requestId: string,
  decisions: Record<string, string>,
  principal: Principal = user
) => requests.answerDecisions(principal, { decisions, requestId });
const row = (id: string) =>
  db.select().from(runRequests).where(eq(runRequests.id, id)).get();
const followUps = (sessionId: string, firstRunId: string) =>
  sessionRuns(sessionId).filter((item) => item.id !== firstRunId);
/** A claimed run that has raised the questions and ended its turn, as an agent does. */
const raisedAndDone = async () => {
  const started = await startRun();
  await claim(started.runId);
  const opened = await raise(started.runId);
  await runs.completeRun(machine, started.runId, {
    status: "done",
    text: "I asked.",
  });
  return { opened, started };
};

test("raising decisions returns at once and never holds the run", async () => {
  const started = await startRun();
  await claim(started.runId);
  const opened = await raise(started.runId);
  expect(opened.kind).toBe("decisions");
  expect(opened.status).toBe("pending");
  expect(opened.toolName).toBe("ask_decisions");
  expect(run(started.runId)?.status).toBe("running");
  expect(opened.display).toEqual({
    questions: QUESTIONS.map((question, index) => ({
      ...question,
      id: `q${index + 1}`,
    })),
  });
  expect(Date.parse(opened.expiresAt) - Date.parse(opened.createdAt)).toBe(
    24 * 60 * 60 * 1000
  );
  await runs.completeRun(machine, started.runId, { status: "done" });
  expect(run(started.runId)?.status).toBe("done");
  // The run ending leaves the card open.
  expect(row(opened.id)?.status).toBe("pending");
});

test("the same questions raised while the card is open give the same card", async () => {
  const started = await startRun();
  await claim(started.runId);
  const first = await raise(started.runId);
  const again = await raise(started.runId);
  expect(again.id).toBe(first.id);
  expect(await requests.listPending(user)).toHaveLength(1);
});

test("a person answers some questions and leaves the rest", async () => {
  const { opened, started } = await raisedAndDone();
  const partial = await answerSome(opened.id, { q1: "Red" });
  expect(partial.status).toBe("pending");
  expect(partial.answer).toEqual({ decisions: { q1: "Red" } });
  expect(partial.outcome).toBeNull();
  expect(followUps(started.sessionId, started.runId)).toHaveLength(0);
  const [pending] = await requests.listPending(user);
  expect(pending?.answer).toEqual({ decisions: { q1: "Red" } });
  // A later answer adds to the earlier ones and replaces one to the same question.
  const more = await answerSome(opened.id, { q1: "Blue", q3: "Later" });
  expect(more.status).toBe("pending");
  expect(more.answer).toEqual({ decisions: { q1: "Blue", q3: "Later" } });
  expect(followUps(started.sessionId, started.runId)).toHaveLength(0);
});

test("the last answer closes the request and starts one follow-up with one line per question", async () => {
  const { opened, started } = await raisedAndDone();
  await answerSome(opened.id, { q1: "Red" });
  const closed = await answerSome(opened.id, {
    q2: "Extra\nlarge, with a lid",
    q3: "Now",
  });
  expect(closed.status).toBe("answered");
  expect(row(opened.id)?.answeredBy).toBe("u1");
  const [followUp] = followUps(started.sessionId, started.runId);
  expect(followUps(started.sessionId, started.runId)).toHaveLength(1);
  expect(followUp?.inputText.split("\n").slice(1)).toEqual([
    "Which colour?: Red",
    "Which size?: Extra large, with a lid",
    "When?: Now",
  ]);
  expect(followUp?.status).toBe("offered");
  // A second answer is refused and starts nothing.
  await expect(answerSome(opened.id, { q1: "Blue" })).rejects.toThrow(
    "already closed"
  );
  expect(followUps(started.sessionId, started.runId)).toHaveLength(1);
});

test("an answer that is not an option, or an unknown question, is refused", async () => {
  const { opened } = await raisedAndDone();
  await expect(answerSome(opened.id, { q1: "Green" })).rejects.toThrow(
    "not an option"
  );
  await expect(answerSome(opened.id, { q9: "Red" })).rejects.toThrow(
    "No question q9"
  );
  await expect(answerSome(opened.id, {})).rejects.toThrow("at least one");
  // Free text is for the question that allows it.
  const typed = await answerSome(opened.id, { q2: "Medium" });
  expect(typed.answer).toEqual({ decisions: { q2: "Medium" } });
});

test("an answer that lands while the run is still going starts the follow-up behind it", async () => {
  const started = await startRun();
  await claim(started.runId);
  const opened = await raise(started.runId);
  await answerSome(opened.id, { q1: "Red", q2: "Large", q3: "Now" });
  expect(run(started.runId)?.status).toBe("running");
  expect(followUps(started.sessionId, started.runId)).toHaveLength(1);
});

test("dismissing hides the card, keeps the answers and tells the agent nothing", async () => {
  const { opened, started } = await raisedAndDone();
  await answerSome(opened.id, { q1: "Red" });
  const dismissed = await requests.dismissDecisions(user, {
    requestId: opened.id,
  });
  expect(dismissed.status).toBe("cancelled");
  expect(row(opened.id)?.answer).toBe(
    JSON.stringify({ decisions: { q1: "Red" } })
  );
  expect(await requests.listPending(user)).toHaveLength(0);
  expect(followUps(started.sessionId, started.runId)).toHaveLength(0);
  await expect(answerSome(opened.id, { q3: "Now" })).rejects.toThrow(
    "already closed"
  );
  await expect(
    requests.dismissDecisions(user, { requestId: opened.id })
  ).rejects.toThrow("already closed");
});

test("the agent can raise dismissed decisions again, and the new card is open", async () => {
  const first = await startRun();
  await claim(first.runId);
  const dismissed = await raise(first.runId);
  await requests.dismissDecisions(user, { requestId: dismissed.id });
  const again = await raise(first.runId);
  expect(again.id).not.toBe(dismissed.id);
  expect(again.status).toBe("pending");
  expect(await requests.listPending(user)).toHaveLength(1);
  await answerSome(again.id, { q1: "Blue", q2: "Small", q3: "Later" });
  expect(followUps(first.sessionId, first.runId)).toHaveLength(1);
});

test("decisions that expire close with the answers so far and wake the agent", async () => {
  const { opened, started } = await raisedAndDone();
  await answerSome(opened.id, { q1: "Red" });
  nowMs += 25 * 60 * 60 * 1000;
  await requests.expireDue({ kind: "system" });
  const expired = row(opened.id);
  expect(expired?.status).toBe("expired");
  const [followUp] = followUps(started.sessionId, started.runId);
  expect(followUps(started.sessionId, started.runId)).toHaveLength(1);
  expect(followUp?.inputText).toContain("expired");
  expect(followUp?.inputText.split("\n").slice(1)).toEqual([
    "Which colour?: Red",
    "Which size?: no answer",
    "When?: no answer",
  ]);
  const record = await requests.outcome(user, opened.id);
  expect(record).toEqual({ status: "expired" });
  // A sweep again starts nothing more, and a late answer is refused.
  await requests.expireDue({ kind: "system" });
  expect(followUps(started.sessionId, started.runId)).toHaveLength(1);
  await expect(answerSome(opened.id, { q3: "Now" })).rejects.toThrow(
    "already closed"
  );
});

test("a card past its time refuses answers before the sweep closes it", async () => {
  const { opened } = await raisedAndDone();
  nowMs += 25 * 60 * 60 * 1000;
  await expect(answerSome(opened.id, { q1: "Red" })).rejects.toThrow(
    "already closed"
  );
});

test("a run that cannot take a follow-up cannot raise decisions", async () => {
  const started = await startRun();
  await claim(started.runId);
  db.update(runRows)
    .set({ dryRun: true })
    .where(eq(runRows.id, started.runId))
    .run();
  await expect(raise(started.runId)).rejects.toThrow("can't raise decisions");
});

test("the generic answer path refuses a decisions card", async () => {
  const { opened } = await raisedAndDone();
  await expect(
    requests.answer(user, {
      answer: { answers: { "Which colour?": "Red" } },
      requestId: opened.id,
      via: "web",
    })
  ).rejects.toThrow("answerDecisions");
});

test("an open decision queue does not hold a run that parked on a question", async () => {
  const started = await startRun();
  await claim(started.runId);
  const decisions = await raise(started.runId);
  const question = await requests.open(machine, {
    kind: "question",
    questions: [{ question: "Which colour?" }],
    runId: started.runId,
    toolName: "AskUserQuestion",
    toolUseId: "ask1",
  });
  await runs.completeRun(machine, started.runId, {
    awaitingAnswer: true,
    runtimeRef: "claude-session",
    status: "done",
    text: "I asked you.",
  });
  await requests.answer(user, {
    answer: { answers: { "Which colour?": "Blue" } },
    requestId: question.id,
    via: "web",
  });
  expect(run(started.runId)?.status).toBe("done");
  expect(followUps(started.sessionId, started.runId)).toHaveLength(1);
  expect(row(decisions.id)?.status).toBe("pending");
});

test("cancelling the run withdraws its decisions, and nothing starts from them", async () => {
  const started = await startRun();
  await claim(started.runId);
  const opened = await raise(started.runId);
  await runs.cancelRun(user, started.runId);
  expect(row(opened.id)?.status).toBe("cancelled");
  await expect(answerSome(opened.id, { q1: "Red" })).rejects.toThrow(
    "already closed"
  );
  expect(followUps(started.sessionId, started.runId)).toHaveLength(0);
});

test("the pending list masks the answers given so far", async () => {
  const { opened } = await raisedAndDone();
  await answerSome(opened.id, { q2: "hunter2" });
  masker = createMasker({ PASSWORD: "hunter2" });
  const [pending] = await requests.listPending(user);
  expect(JSON.stringify(pending?.answer)).not.toContain("hunter2");
  // The row keeps what the person typed, for the agent.
  expect(row(opened.id)?.answer).toContain("hunter2");
});

test("the same questions raised by a later run get a card of their own, which that run's cancel closes", async () => {
  const first = await raisedAndDone();
  const second = await startRun();
  await claim(second.runId);
  const mine = await raise(second.runId);
  expect(mine.id).not.toBe(first.opened.id);
  await runs.cancelRun(user, second.runId);
  expect(row(mine.id)?.status).toBe("cancelled");
  expect(row(first.opened.id)?.status).toBe("pending");
});
