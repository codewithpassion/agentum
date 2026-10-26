import { beforeEach, expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { inboxPosts } from "@repo/db/schema/inbox";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import type { RunStatus } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { createMasker } from "@repo/protocol/masker";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { createDeskService, type DeskInput } from "./desk.ts";
import { createEventsService, type PeopleLookup } from "./events.ts";
import { createInboxService } from "./inbox.ts";
import { memoryLibraryBlobs } from "./library/memory.ts";
import { createLibraryService } from "./library.ts";
import { createRequestsService } from "./requests.ts";
import { createRoutinesService } from "./routines.ts";
import type { RuntimeAdapter } from "./runs/types.ts";
import { createRunsService } from "./runs.ts";
import { memorySkillBlobs } from "./skills-store/memory.ts";
import { createSkillsStoreService } from "./skills-store.ts";
import { createTriggersService } from "./triggers.ts";
import { type Principal, SYSTEM_PRINCIPAL as system } from "./workspaces.ts";

const user = (userId = "u1", workspaceId = "w1"): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});
const DAY_START = "2026-10-26T00:00:00.000Z";
const NOW = Date.parse("2026-10-26T09:00:00Z");

let db: ReturnType<typeof migrated>;
let now: number;
let agents: AgentsService;
let events: ReturnType<typeof createEventsService>;
let requests: ReturnType<typeof createRequestsService>;
let runs: ReturnType<typeof createRunsService>;
let skillsStore: ReturnType<typeof createSkillsStoreService>;
let triggers: ReturnType<typeof createTriggersService>;
let routines: ReturnType<typeof createRoutinesService>;
let desk: ReturnType<typeof createDeskService>;
let people: PeopleLookup | undefined;
let a1: string;
let a2: string;
let b1: string;
let counter: number;

const get = (input: Partial<DeskInput> = {}, principal = user()) =>
  desk.get(principal, { dayStart: DAY_START, ...input });

const buildDesk = () =>
  createDeskService({
    clock: { now: () => new Date(now), sleep: () => Promise.resolve() },
    db,
    inbox: createInboxService({
      atomic: sqliteAtomic(db),
      clock: { now: () => new Date(now), sleep: () => Promise.resolve() },
      db,
      events,
      runs: { startRun: (principal, input) => runs.startRun(principal, input) },
    }),
    people,
    requests,
    routines,
    skillsStore,
    triggers,
  });

beforeEach(async () => {
  db = migrated();
  now = NOW;
  counter = 0;
  people = undefined;
  const iso = new Date(now).toISOString();
  await db.insert(workspaces).values(
    ["w1", "w2"].map((id) => ({
      clerkOrgId: `org_${id}`,
      createdAt: iso,
      id,
      name: id,
      timezone: "UTC",
    }))
  );
  const clock = {
    now: () => new Date(now),
    sleep: () => Promise.resolve(),
  };
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
  const library = createLibraryService({
    atomic,
    blobs: memoryLibraryBlobs(),
    clock,
    db,
    events,
  });
  skillsStore = createSkillsStoreService({
    atomic,
    blobs: memorySkillBlobs(),
    clock,
    db,
    events,
    library,
  });
  triggers = createTriggersService({
    allowedOrgIds: ["org_w1", "org_w2"],
    clock,
    db,
    events,
    runs,
  });
  routines = createRoutinesService({
    allowedOrgIds: ["org_w1", "org_w2"],
    clock,
    db,
    events,
    runs,
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
  desk = buildDesk();
});

interface SeedRun {
  actorId?: string;
  actorKind?: string;
  agentId?: string;
  error?: string;
  finishedAt?: string;
  inputText?: string;
  origin?: string;
  private?: boolean;
  resultText?: string;
  startedAt?: string;
  status: RunStatus;
  workspaceId?: string;
}

/** A run row with its session, inserted directly so its times are exact. */
const seed = async (o: SeedRun): Promise<string> => {
  counter += 1;
  const id = `run${String(counter).padStart(3, "0")}`;
  const workspaceId = o.workspaceId ?? "w1";
  const agentId = o.agentId ?? (workspaceId === "w1" ? a1 : b1);
  const createdAt = new Date(NOW - 60_000 + counter * 1000).toISOString();
  await db.insert(sessions).values({
    actorId: o.actorId ?? "u1",
    actorKind: o.actorKind ?? "user",
    agentId,
    createdAt,
    id: `s-${id}`,
    origin: o.origin ?? "mcp",
    private: o.private ?? false,
    workspaceId,
  });
  await db.insert(runRows).values({
    actorId: o.actorId ?? "u1",
    actorKind: o.actorKind ?? "user",
    agentId,
    createdAt,
    error: o.error ?? null,
    finishedAt: o.finishedAt ?? null,
    id,
    inputText: o.inputText ?? `Task ${id}`,
    resultText: o.resultText ?? null,
    sessionId: `s-${id}`,
    startedAt: o.startedAt ?? null,
    status: o.status,
    workspaceId,
  });
  return id;
};

const runPrincipal = (agentId: string, runId: string, workspaceId = "w1") =>
  ({ agentId, kind: "run", runId, workspaceId }) as const;

const ids = (cards: { id: string }[]) => cards.map((card) => card.id);

/** A real run that waits on an approval, as a person's chat would leave it. */
const waitingOnApproval = async (agentId = a1, userId = "u1") => {
  const started = await runs.startRun(user(userId), {
    agentId,
    input: { text: "deploy the thing" },
    session: { origin: "ui" },
  });
  await runs.claimRun(system, started.runId);
  const request = await requests.open(system, {
    input: { command: "rm -rf build" },
    kind: "approval",
    runId: started.runId,
    toolKey: "bash",
    toolName: "bash",
    toolUseId: "call1",
  });
  return { requestId: request.id, runId: started.runId };
};

test("Running holds queued, offered, running and waiting runs, newest first, and Done holds today's finished runs", async () => {
  const queued = await seed({ status: "queued" });
  const offered = await seed({ status: "offered" });
  const running = await seed({ startedAt: DAY_START, status: "running" });
  const waiting = await seed({ status: "waiting" });
  const done = await seed({
    finishedAt: "2026-10-26T08:00:00.000Z",
    resultText: "All sorted. More detail.",
    status: "done",
  });
  const failed = await seed({
    error: "Out of credit",
    finishedAt: "2026-10-26T08:30:00.000Z",
    status: "failed",
  });
  const cancelled = await seed({
    finishedAt: "2026-10-26T07:00:00.000Z",
    status: "cancelled",
  });
  const interrupted = await seed({
    finishedAt: "2026-10-26T06:00:00.000Z",
    status: "interrupted",
  });
  await seed({ finishedAt: "2026-10-25T23:00:00.000Z", status: "done" });

  const view = await get();

  expect(ids(view.running)).toEqual([waiting, running, offered, queued]);
  expect(ids(view.done)).toEqual([failed, done, cancelled, interrupted]);
  expect(view.doneMore).toBe(0);
  expect(view.needsYou).toEqual([]);
  expect(view.running.map((card) => card.lane)).toEqual([
    "running",
    "running",
    "running",
    "running",
  ]);
  expect(view.done.find((card) => card.id === done)).toMatchObject({
    band: { text: "All sorted.", tone: "ok" },
    kind: "run",
    lane: "done",
    runId: done,
    title: `Task ${done}`,
  });
  expect(view.done.find((card) => card.id === failed)?.band).toEqual({
    text: "Out of credit",
    tone: "error",
  });
  expect(view.running.find((card) => card.id === queued)?.band).toEqual({
    text: "Waiting to start",
    tone: "waiting",
  });
});

test("Done today starts at dayStart: a run finished at that instant counts and one a millisecond earlier does not", async () => {
  const onTheDot = await seed({ finishedAt: DAY_START, status: "done" });
  await seed({ finishedAt: "2026-10-25T23:59:59.999Z", status: "done" });
  const later = await seed({
    finishedAt: "2026-10-26T00:00:00.001Z",
    status: "done",
  });

  expect(ids((await get()).done)).toEqual([later, onTheDot]);
  // A time without milliseconds is the same instant.
  expect(ids((await get({ dayStart: "2026-10-26T00:00:00Z" })).done)).toEqual([
    later,
    onTheDot,
  ]);
  expect(
    ids((await get({ dayStart: "2026-10-26T00:00:00.001Z" })).done)
  ).toEqual([later]);
  await expect(get({ dayStart: "yesterday" })).rejects.toThrow();
});

test("Done today shows 20 runs, newest first, and counts the rest", async () => {
  // `seed` numbers its runs when called, so the ids follow the minutes.
  const made = await Promise.all(
    Array.from({ length: 23 }, (_, minute) =>
      seed({
        finishedAt: new Date(
          Date.parse(DAY_START) + minute * 60_000
        ).toISOString(),
        status: "done",
      })
    )
  );

  const view = await get();

  expect(view.done).toHaveLength(20);
  expect(view.doneMore).toBe(3);
  expect(ids(view.done)).toEqual(made.slice(3).reverse());
});

test("a waiting run sits in Running while its approval sits in Needs you, and answering clears the card", async () => {
  const { requestId, runId } = await waitingOnApproval();

  const view = await get();

  expect(ids(view.running)).toEqual([runId]);
  expect(view.running.map((card) => card.band.tone)).toEqual(["waiting"]);
  expect(view.running.map((card) => card.band.text)[0]).toStartWith(
    "Waiting for approval"
  );
  expect(view.needsYou).toHaveLength(1);
  expect(view.needsYou[0]).toMatchObject({
    agentId: a1,
    id: requestId,
    kind: "request",
    lane: "needs_you",
    needsYouKind: "approval",
    runId,
  });
  expect(view.needsYou.map((card) => card.band.tone)).toEqual(["waiting"]);
  expect(await desk.needsYouCount(user())).toBe(1);

  await requests.answer(user(), {
    answer: { decision: "allow_once" },
    requestId,
    via: "web",
  });

  expect((await get()).needsYou).toEqual([]);
  expect(await desk.needsYouCount(user())).toBe(0);
});

test("a question waits in Needs you as a question card", async () => {
  const started = await runs.startRun(user(), {
    agentId: a1,
    input: { text: "plan the week" },
    session: { origin: "ui" },
  });
  await runs.claimRun(system, started.runId);
  const request = await requests.open(system, {
    kind: "question",
    questions: [{ header: "Which day?", question: "Which day suits you?" }],
    runId: started.runId,
    toolName: "ask_user",
    toolUseId: "q1",
  });

  const { needsYou } = await get();

  expect(needsYou).toHaveLength(1);
  expect(needsYou[0]).toMatchObject({
    id: request.id,
    needsYouKind: "question",
    title: "Which day?",
  });
});

test("a running run's band follows its newest tool call or assistant message", async () => {
  const quiet = await seed({ status: "running" });
  const searching = await seed({ status: "running" });
  const append = (
    runId: string,
    type: "message.assistant" | "tool.call",
    payload: Record<string, unknown>
  ) =>
    events.append({
      actor: { id: a1, kind: "agent" },
      agentId: a1,
      payload,
      runId,
      sessionId: `s-${runId}`,
      type,
      workspaceId: "w1",
    });
  await append(searching, "message.assistant", { text: "Looking." });
  await append(searching, "tool.call", {
    input: {},
    name: "web_search",
    toolUseId: "t1",
  });

  const bands = new Map(
    (await get()).running.map((card) => [card.id, card.band])
  );

  expect(bands.get(quiet)).toEqual({ text: "Thinking", tone: "running" });
  expect(bands.get(searching)).toEqual({
    text: "Web search",
    tone: "running",
  });

  await append(searching, "message.assistant", { text: "Found it." });

  expect(
    (await get()).running.find((card) => card.id === searching)?.band
  ).toEqual({ text: "Thinking", tone: "running" });
});

test("the agent filter narrows every lane to one agent but not the badge", async () => {
  // One live run per agent can be claimed, so the real waiting runs go first.
  const first = await waitingOnApproval(a1);
  const second = await waitingOnApproval(a2);
  const mine = await seed({ agentId: a1, status: "running" });
  await seed({ agentId: a2, status: "running" });
  const doneMine = await seed({
    agentId: a1,
    finishedAt: "2026-10-26T08:00:00.000Z",
    status: "done",
  });
  await seed({
    agentId: a2,
    finishedAt: "2026-10-26T08:00:00.000Z",
    status: "done",
  });

  const all = await get();
  const filtered = await get({ agentId: a1 });

  expect(all.needsYou).toHaveLength(2);
  expect(ids(filtered.running).sort()).toEqual([first.runId, mine].sort());
  expect(ids(filtered.done)).toEqual([doneMine]);
  expect(ids(filtered.needsYou)).toEqual([first.requestId]);
  expect(ids((await get({ agentId: a2 })).needsYou)).toEqual([
    second.requestId,
  ]);
  expect(await desk.needsYouCount(user())).toBe(2);
});

test("proposals wait in Needs you until they are approved or rejected elsewhere", async () => {
  const runId = await seed({ agentId: a1, status: "running" });
  const agent = runPrincipal(a1, runId);
  const { skill } = await skillsStore.create(agent, {
    files: [
      {
        content: "---\nname: tidy\ndescription: Tidies up.\n---\n\n# tidy\n",
        path: "SKILL.md",
      },
    ],
    message: "Add tidy",
    name: "tidy",
  });
  const keep = (await triggers.create(agent, { agentId: a1, name: "Keep me" }))
    .trigger;
  const approve = (
    await triggers.create(agent, { agentId: a1, name: "Approve me" })
  ).trigger;
  const reject = (
    await triggers.create(agent, { agentId: a1, name: "Reject me" })
  ).trigger;
  const routine = await routines.create(agent, {
    agentId: a1,
    cron: "0 9 * * *",
    name: "Morning",
    prompt: "Say hello",
  });

  const before = await get();

  expect(
    before.needsYou.map((card) => [card.needsYouKind, card.title]).sort()
  ).toEqual(
    [
      ["routine_proposal", "Morning"],
      ["skill_proposal", "tidy"],
      ["trigger_proposal", "Approve me"],
      ["trigger_proposal", "Keep me"],
      ["trigger_proposal", "Reject me"],
    ].sort()
  );
  expect(before.needsYou.every((card) => card.kind === "proposal")).toBe(true);
  expect(before.needsYou.every((card) => card.agentId === a1)).toBe(true);
  expect(before.needsYou.every((card) => card.startedBy === "Alpha")).toBe(
    true
  );
  expect(await desk.needsYouCount(user())).toBe(5);

  await skillsStore.approve(user(), { skillId: skill.id, version: 1 });
  await triggers.approve(user(), approve.id);
  await triggers.reject(user(), reject.id);
  await routines.approve(user(), routine.id);

  const after = await get();
  expect(ids(after.needsYou)).toEqual([keep.id]);
  expect(await desk.needsYouCount(user())).toBe(1);
});

test("an inbox thread waits in Needs you while an agent's post is the newest, and leaves when a person replies", async () => {
  const inbox = createInboxService({
    atomic: sqliteAtomic(db),
    clock: { now: () => new Date(now), sleep: () => Promise.resolve() },
    db,
    events,
    runs: { startRun: (principal, input) => runs.startRun(principal, input) },
  });
  const waiting = await inbox.createThread(user(), { title: "Plans" });
  const quiet = await inbox.createThread(user(), { title: "Chat" });
  await inbox.post(user(), { text: "Hello", threadId: waiting.id });
  await inbox.post(user(), { text: "Hi", threadId: quiet.id });
  const agentPost = (threadId: string, text: string, n: number) =>
    db.insert(inboxPosts).values({
      authorId: a2,
      authorKind: "agent",
      createdAt: new Date(now + n).toISOString(),
      id: `zz-post-${threadId}-${n}`,
      text,
      threadId,
      workspaceId: "w1",
    });
  await agentPost(waiting.id, "Here is the plan. Second sentence.", 1);

  const first = await get();

  expect(first.needsYou).toHaveLength(1);
  expect(first.needsYou[0]).toMatchObject({
    agentId: a2,
    id: waiting.id,
    kind: "thread",
    lane: "needs_you",
    needsYouKind: "inbox_reply",
    startedBy: "Beta",
    threadId: waiting.id,
    title: "Plans",
  });
  expect(await desk.needsYouCount(user())).toBe(1);

  await db.insert(inboxPosts).values({
    authorId: "u1",
    authorKind: "user",
    createdAt: new Date(now + 2).toISOString(),
    id: `zzz-post-${waiting.id}-2`,
    text: "Thanks",
    threadId: waiting.id,
    workspaceId: "w1",
  });

  expect((await get()).needsYou).toEqual([]);
  expect(await desk.needsYouCount(user())).toBe(0);
});

test("another member's chat and a private DM never show, but shared sessions do", async () => {
  await waitingOnApproval(a1, "u2");
  const shared = await seed({ origin: "mcp", status: "running" });
  const own = await seed({ origin: "ui", status: "running" });
  await seed({ actorId: "u2", origin: "ui", status: "running" });
  await seed({
    actorId: "u2",
    origin: "slack",
    private: true,
    status: "running",
  });
  const doneShared = await seed({
    actorId: "u2",
    finishedAt: "2026-10-26T08:00:00.000Z",
    origin: "slack",
    status: "done",
  });
  await seed({
    actorId: "u2",
    finishedAt: "2026-10-26T08:00:00.000Z",
    origin: "ui",
    status: "done",
  });

  const view = await get();

  expect(ids(view.running).sort()).toEqual([own, shared].sort());
  expect(ids(view.done)).toEqual([doneShared]);
  expect(view.needsYou).toEqual([]);
  expect(await desk.needsYouCount(user())).toBe(0);
  expect(await desk.needsYouCount(user("u2"))).toBe(1);
});

test("two workspaces never see each other's runs, requests or proposals", async () => {
  const started = await runs.startRun(user("u9", "w2"), {
    agentId: b1,
    input: { text: "theirs" },
    session: { origin: "ui" },
  });
  await runs.claimRun(system, started.runId);
  await requests.open(system, {
    input: { command: "ls" },
    kind: "approval",
    runId: started.runId,
    toolKey: "bash",
    toolName: "bash",
    toolUseId: "c",
  });

  const mineRun = await seed({ status: "running" });
  await seed({ status: "running", workspaceId: "w2" });
  await seed({
    finishedAt: "2026-10-26T08:00:00.000Z",
    status: "done",
    workspaceId: "w2",
  });
  const other = await seed({ status: "running", workspaceId: "w2" });
  await triggers.create(runPrincipal(b1, other, "w2"), {
    agentId: b1,
    name: "Theirs",
  });
  const mine = await get();
  const theirs = await get({}, user("u9", "w2"));

  expect(ids(mine.running)).toEqual([mineRun]);
  expect(mine.done).toEqual([]);
  expect(mine.needsYou).toEqual([]);
  expect(await desk.needsYouCount(user())).toBe(0);
  expect(theirs.running).toHaveLength(3);
  expect(theirs.done).toHaveLength(1);
  expect(theirs.needsYou.map((card) => card.needsYouKind).sort()).toEqual([
    "approval",
    "trigger_proposal",
  ]);
  expect((await get({ agentId: b1 })).running).toEqual([]);
});

test("startedBy names the person, falls back when the lookup fails, and names an agent or a trigger", async () => {
  const byPerson = await seed({ actorId: "u1", status: "running" });
  const byAgent = await seed({
    actorId: a2,
    actorKind: "agent",
    status: "running",
  });
  const bySystem = await seed({
    actorId: "tick",
    actorKind: "system",
    status: "running",
  });
  const startedBy = async () =>
    new Map((await get()).running.map((card) => [card.id, card.startedBy]));

  expect((await startedBy()).get(byPerson)).toBe("A teammate");

  people = () =>
    Promise.resolve(new Map([["u1", { email: "d@x.io", name: "Dana" }]]));
  desk = buildDesk();
  const named = await startedBy();
  expect(named.get(byPerson)).toBe("Dana");
  expect(named.get(byAgent)).toBe("Beta");
  expect(named.get(bySystem)).toBe("System");

  people = () => Promise.reject(new Error("Clerk is down"));
  desk = buildDesk();
  const logged = spyOn(console, "error").mockImplementation(() => undefined);
  expect((await startedBy()).get(byPerson)).toBe("A teammate");
  expect(logged).toHaveBeenCalledTimes(1);
  logged.mockRestore();
});

test("only a person reads the desk", async () => {
  await expect(get({}, system)).rejects.toBeInstanceOf(ForbiddenError);
  await expect(get({}, runPrincipal(a1, "r1"))).rejects.toBeInstanceOf(
    ForbiddenError
  );
  await expect(desk.needsYouCount(system)).rejects.toBeInstanceOf(
    ForbiddenError
  );
});
