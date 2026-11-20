import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { machines } from "@repo/db/schema/machines";
import { runRequests } from "@repo/db/schema/requests";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createAgentsService } from "./agents.ts";
import { createDeskService } from "./desk.ts";
import { createEventsService } from "./events.ts";
import { createInboxService } from "./inbox.ts";
import { memoryLibraryBlobs } from "./library/memory.ts";
import { createLibraryService } from "./library.ts";
import { createMachineRuntime } from "./machines/runtime.ts";
import { noopRelay } from "./machines/types.ts";
import { createRequestsService, type RequestsService } from "./requests.ts";
import { createRoutinesService } from "./routines.ts";
import type { Clock } from "./runs/types.ts";
import { createRunsService, type RunsService } from "./runs.ts";
import { memorySkillBlobs } from "./skills-store/memory.ts";
import { createSkillsStoreService } from "./skills-store.ts";
import { createTriggersService } from "./triggers.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const START = "2026-10-26T09:00:00.000Z";
const DAY_START = "2026-10-26T00:00:00.000Z";
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
let agentId: string;
let runs: RunsService;
let requests: RequestsService;
let desk: ReturnType<typeof createDeskService>;

const clock: Clock = {
  now: () => new Date(nowMs),
  sleep: () => Promise.resolve(),
};

const row = (id: string) =>
  db.select().from(runRequests).where(eq(runRequests.id, id)).get();

const startRun = async () => {
  nowMs += 1000;
  return await runs.startRun(user, {
    agentId,
    input: { text: "hi" },
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
  const atomic = sqliteAtomic(db);
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
    atomic,
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [
      {
        deliver: () => Promise.resolve(),
        kind: "none",
      },
    ],
    runTokenKey: KEY,
  });
  requests = createRequestsService({
    atomic,
    clock,
    db,
    events,
    runs,
    secrets: { maskerFor: () => Promise.resolve(null) },
  });
  const library = createLibraryService({
    atomic,
    blobs: memoryLibraryBlobs(),
    clock,
    db,
    events,
  });
  const skillsStore = createSkillsStoreService({
    atomic,
    blobs: memorySkillBlobs(),
    clock,
    db,
    events,
    library,
  });
  desk = createDeskService({
    clock,
    db,
    inbox: createInboxService({
      atomic,
      clock,
      db,
      events,
      runs: { startRun: (principal, input) => runs.startRun(principal, input) },
    }),
    requests,
    routines: createRoutinesService({ clock, db, events, runs }),
    skillsStore,
    triggers: createTriggersService({ clock, db, events, runs }),
  });
});

const QUESTIONS = [
  { options: ["Blue", "Red"], text: "Which colour?" },
  { freeText: true, options: ["Small", "Large"], text: "Which size?" },
  { options: ["Now", "Later"], text: "When?" },
];

/** A claimed run that raises the three questions, as an agent does. */
const raiseQuestions = async () => {
  const started = await startRun();
  await claim(started.runId);
  const opened = await requests.openDecisions(machine, {
    questions: QUESTIONS,
    runId: started.runId,
  });
  return { opened, started };
};

const decisionCards = async () =>
  (await desk.railSources(user, { dayStart: DAY_START })).needsYou.filter(
    (card) => card.needsYouKind === "decisions"
  );

test("an open decision queue is one Needs you card of kind decisions with its request", async () => {
  const { opened } = await raiseQuestions();

  const rail = await desk.railSources(user, { dayStart: DAY_START });

  expect(rail.needsYou).toHaveLength(1);
  expect(rail.needsYou[0]).toMatchObject({
    id: opened.id,
    needsYouKind: "decisions",
    title: "3 decisions",
  });
  expect(rail.pending.map((record) => record.id)).toEqual([opened.id]);
  expect(rail.pending[0]).toMatchObject({
    kind: "decisions",
    status: "pending",
  });
  expect(await desk.needsYouCount(user)).toBe(1);
});

test("a partial answer keeps the card, and the last answer removes it", async () => {
  const { opened } = await raiseQuestions();

  await requests.answerDecisions(user, {
    decisions: { q1: "Red" },
    requestId: opened.id,
  });
  expect(await decisionCards()).toHaveLength(1);
  expect(await desk.needsYouCount(user)).toBe(1);

  await requests.answerDecisions(user, {
    decisions: { q2: "Large", q3: "Now" },
    requestId: opened.id,
  });
  expect(row(opened.id)?.status).toBe("answered");
  expect(await decisionCards()).toHaveLength(0);
  expect(await desk.needsYouCount(user)).toBe(0);
});

test("dismissing the queue removes its card", async () => {
  const { opened } = await raiseQuestions();

  await requests.dismissDecisions(user, { requestId: opened.id });

  expect(await decisionCards()).toHaveLength(0);
  expect(await desk.needsYouCount(user)).toBe(0);
});
