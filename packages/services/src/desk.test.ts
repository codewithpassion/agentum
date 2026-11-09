import { beforeEach, expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agentConnectors, connectors } from "@repo/db/schema/connectors";
import { inboxPosts } from "@repo/db/schema/inbox";
import { libraryConflicts } from "@repo/db/schema/library";
import {
  agentMailboxes,
  mailMessages,
  mailThreads,
} from "@repo/db/schema/mail";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { skillVersions } from "@repo/db/schema/skills";
import { workspaces } from "@repo/db/schema/workspaces";
import { type RunStatus, SKILL_CHANGE_TTL_MS } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { createMasker } from "@repo/protocol/masker";
import { eq } from "drizzle-orm";
import type { ConnectionSummary } from "./a2a/connections.ts";
import type { WaitingMessage } from "./a2a/needs-you.ts";
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
let waitingA2a: WaitingMessage[];
let connectionsA2a: ConnectionSummary[];
/** The A2A source the desk reads: whatever the test set in `waitingA2a` and `connectionsA2a`. */
const fakeA2a = {
  connections: { list: () => Promise.resolve(connectionsA2a) },
  tasks: { listWaiting: () => Promise.resolve(waitingA2a) },
};
let a1: string;
let a2: string;
let b1: string;
let counter: number;

const get = (input: Partial<DeskInput> = {}, principal = user()) =>
  desk.get(principal, { dayStart: DAY_START, ...input });

const buildDesk = () =>
  createDeskService({
    a2a: fakeA2a,
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
  waitingA2a = [];
  connectionsA2a = [];
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
    clock,
    db,
    events,
    runs,
  });
  routines = createRoutinesService({
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

test("a run's change to a people's skill waits in Needs you as a request to change it", async () => {
  const runId = await seed({ agentId: a1, status: "running" });
  const { skill } = await skillsStore.create(user(), {
    files: [
      {
        content: "---\nname: tidy\ndescription: Tidies up.\n---\n\n# tidy\n",
        path: "SKILL.md",
      },
    ],
    message: "Add tidy",
    name: "tidy",
  });
  await skillsStore.assign(user(), { agentId: a1, skillId: skill.id });
  await skillsStore.commit(runPrincipal(a1, runId), {
    baseVersion: 1,
    message: "Tidy more",
    skillId: skill.id,
    writes: [
      {
        content:
          "---\nname: tidy\ndescription: Tidies up.\n---\n\n# tidy\n\nMore.\n",
        path: "SKILL.md",
      },
    ],
  });

  const rail = await desk.railSources(user(), { dayStart: DAY_START });

  expect(rail.needsYou).toHaveLength(1);
  expect(rail.needsYou[0]).toMatchObject({
    agentId: a1,
    needsYouKind: "skill_proposal",
    startedBy: "Alpha",
    title: "tidy",
  });
  expect(rail.needsYou.map((card) => card.band.text)).toEqual([
    "Wants to change this skill: Tidy more",
  ]);
});

test("a skill change from a run a peer started shows the peer as its origin", async () => {
  const runId = await seed({
    actorId: "conn-bob",
    actorKind: "peer",
    agentId: a1,
    status: "running",
  });
  const { skill } = await skillsStore.create(user(), {
    files: [
      {
        content: "---\nname: tidy\ndescription: Tidies up.\n---\n\n# tidy\n",
        path: "SKILL.md",
      },
    ],
    message: "Add tidy",
    name: "tidy",
  });
  await skillsStore.assign(user(), { agentId: a1, skillId: skill.id });
  await skillsStore.commit(runPrincipal(a1, runId), {
    baseVersion: 1,
    message: "Tidy more",
    skillId: skill.id,
    writes: [
      {
        content:
          "---\nname: tidy\ndescription: Tidies up.\n---\n\n# tidy\n\nMore.\n",
        path: "SKILL.md",
      },
    ],
  });

  const rail = await desk.railSources(user(), { dayStart: DAY_START });

  expect(rail.needsYou).toHaveLength(1);
  expect(rail.needsYou[0]).toMatchObject({
    agentId: a1,
    needsYouKind: "skill_proposal",
    startedBy: "A peer",
  });
});

test("a GitHub update a person proposed waits as a card from that person, not from an agent", async () => {
  people = () =>
    Promise.resolve(new Map([["u1", { email: "d@x.io", name: "Dom" }]]));
  desk = buildDesk();
  const { skill } = await skillsStore.create(user(), {
    files: [
      {
        content: "---\nname: tidy\ndescription: Tidies up.\n---\n\n# tidy\n",
        path: "SKILL.md",
      },
    ],
    message: "Add tidy",
    name: "tidy",
  });
  await db.insert(skillVersions).values({
    authorId: "u1",
    authorKind: "user",
    createdAt: new Date(now).toISOString(),
    id: "zz-update",
    message: "Proposed update from GitHub",
    number: 2,
    parentNumber: 1,
    skillId: skill.id,
    sourceCommitSha: "b".repeat(40),
    status: "proposed",
    workspaceId: "w1",
  });

  const { needsYou } = await get();

  expect(needsYou).toHaveLength(1);
  expect(needsYou[0]).toMatchObject({
    actorKind: "user",
    id: "zz-update",
    needsYouKind: "skill_proposal",
    startedBy: "Dom",
    title: "Update from GitHub to review",
  });
  expect(needsYou.map((card) => card.band.text).join()).toContain("tidy");
  expect(JSON.stringify(needsYou)).not.toContain("An agent");
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

test("a dismissed inbox thread leaves Needs you until an agent posts again, and a person's post keeps it out", async () => {
  const inbox = createInboxService({
    atomic: sqliteAtomic(db),
    clock: { now: () => new Date(now), sleep: () => Promise.resolve() },
    db,
    events,
    runs: { startRun: (principal, input) => runs.startRun(principal, input) },
  });
  const thread = await inbox.createThread(user(), { title: "Plans" });
  const post = (authorKind: "agent" | "user", n: number) =>
    db.insert(inboxPosts).values({
      authorId: authorKind === "agent" ? a2 : "u1",
      authorKind,
      createdAt: new Date(NOW + n).toISOString(),
      id: `zz-post-${authorKind}-${n}`,
      text: "Here is the plan.",
      threadId: thread.id,
      workspaceId: "w1",
    });
  await post("agent", 1);
  now = NOW + 2;
  expect(ids((await get()).needsYou)).toEqual([thread.id]);

  await inbox.clearAttention(user(), { threadId: thread.id });

  expect((await get()).needsYou).toEqual([]);
  expect(await desk.needsYouCount(user())).toBe(0);

  await post("agent", 3);
  now = NOW + 4;
  expect(ids((await get()).needsYou)).toEqual([thread.id]);
  expect(await desk.needsYouCount(user())).toBe(1);

  await inbox.clearAttention(user(), { threadId: thread.id });
  await post("user", 5);
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

test("draft dry-run history is absent from desk lanes and counts", async () => {
  const draft = await agents.createDraft(user(), { name: "Draft" });
  const runId = await seed({ agentId: draft.id, status: "running" });
  await requests.open(system, {
    kind: "question",
    questions: [{ header: "Draft?", question: "Ready?" }],
    runId,
    toolName: "ask_user",
    toolUseId: "draft-question",
  });
  await skillsStore.create(runPrincipal(draft.id, runId), {
    files: [
      {
        content: "---\nname: draft-skill\ndescription: Draft.\n---\n",
        path: "SKILL.md",
      },
    ],
    message: "Draft proposal",
    name: "draft-skill",
  });
  await seed({ agentId: draft.id, finishedAt: DAY_START, status: "done" });
  const live = await seed({ status: "running" });
  const view = await get();
  expect(ids(view.running)).toEqual([live]);
  expect(view.done).toEqual([]);
  expect(view.doneMore).toBe(0);
  expect(view.needsYou).toEqual([]);
  expect(await desk.needsYouCount(user())).toBe(0);
  expect(
    await desk.pendingRequests({
      kind: "user",
      userId: "u1",
      via: "session",
      workspaceId: "w1",
    })
  ).toEqual([]);
});

test("a dry run never shows in Running or Done today, even to the person who started it", async () => {
  const live = await seed({ status: "running" });
  const dryLive = await seed({
    origin: "dry_run",
    private: true,
    status: "running",
  });
  const done = await seed({ finishedAt: DAY_START, status: "done" });
  const dryDone = await seed({
    finishedAt: "2026-10-26T08:00:00.000Z",
    origin: "dry_run",
    private: true,
    status: "done",
  });
  await db.update(runRows).set({ dryRun: true }).where(eq(runRows.id, dryLive));
  await db.update(runRows).set({ dryRun: true }).where(eq(runRows.id, dryDone));

  const view = await get();

  expect(ids(view.running)).toEqual([live]);
  expect(ids(view.done)).toEqual([done]);
  expect(view.doneMore).toBe(0);
});

test("mail run shows a bounced outbound error band", async () => {
  const started = await runs.startRun(user(), {
    agentId: a1,
    input: { text: "mail" },
    session: { externalKey: "mail:box:t", origin: "mail" },
  });
  await db.insert(agentMailboxes).values({
    address: "agent@example.com",
    agentId: a1,
    createdAt: new Date(now).toISOString(),
    id: "box",
    status: "active",
    workspaceId: "w1",
  });
  await db.insert(mailThreads).values({
    externalThreadId: "t",
    id: "thread",
    lastMessageAt: new Date(now).toISOString(),
    mailboxId: "box",
    sessionId: started.sessionId,
    subject: "Help",
    workspaceId: "w1",
  });
  await db.insert(mailMessages).values({
    ccAddresses: "[]",
    createdAt: new Date(now).toISOString(),
    direction: "out",
    externalMessageId: "m",
    fromAddress: '{"address":"sender@example.net"}',
    id: "mail",
    runId: started.runId,
    snippet: "",
    status: "bounced",
    subject: "Help",
    threadId: "thread",
    toAddresses: '["recipient@example.net"]',
    workspaceId: "w1",
  });
  expect(
    (await get()).running.find((card) => card.id === started.runId)?.band
  ).toEqual({ text: "Mail to recipient@example.net bounced", tone: "error" });
});

test("takeovers appear in Needs you with their reason", async () => {
  const { requestId } = await waitingOnApproval();
  await db
    .update(runRequests)
    .set({
      display: JSON.stringify({
        machineId: "computer",
        reason: "Please log in",
      }),
      kind: "takeover",
    })
    .where(eq(runRequests.id, requestId));
  expect(
    (
      await desk.pendingRequests({
        kind: "user",
        userId: "u1",
        via: "session",
        workspaceId: "w1",
      })
    )[0]
  ).toMatchObject({
    detail: "Please log in",
    kind: "takeover",
  });
  expect((await get()).needsYou[0]).toMatchObject({
    needsYouKind: "takeover",
    title: "Take over the computer",
  });
});

test("Needs you includes only open library conflicts in the workspace and agent filter", async () => {
  const createdAt = new Date(NOW).toISOString();
  await db.insert(libraryConflicts).values([
    {
      agentId: a1,
      conflictPath: "a.conflict-r",
      createdAt,
      id: "open",
      path: "a",
      status: "open",
      workspaceId: "w1",
    },
    {
      agentId: a2,
      conflictPath: "b.conflict-r",
      createdAt,
      id: "closed",
      path: "b",
      status: "resolved",
      workspaceId: "w1",
    },
    {
      agentId: b1,
      conflictPath: "c.conflict-r",
      createdAt,
      id: "other",
      path: "c",
      status: "open",
      workspaceId: "w2",
    },
  ]);
  const cards = (await get()).needsYou;
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    agentId: a1,
    id: "open",
    kind: "conflict",
    needsYouKind: "library_conflict",
    title: "a",
  });
  expect(await desk.needsYouCount(user())).toBe(1);
  expect((await get({ agentId: a2 })).needsYou).toEqual([]);
});

const bobMessage = (
  overrides: Partial<WaitingMessage> = {}
): WaitingMessage => ({
  agentId: a1,
  connectionId: "conn-bob",
  createdAt: new Date(NOW).toISOString(),
  host: "bob.example",
  org: "Bob Co",
  peer: "Bob's agent",
  taskId: "task-1",
  text: "Hello Alpha",
  ...overrides,
});

const bobConnection = (
  overrides: Partial<ConnectionSummary> = {}
): ConnectionSummary => ({
  agentId: a1,
  agentName: "Alpha",
  approvedAt: null,
  approvedBy: null,
  checkCode: "482913",
  createdAt: new Date(NOW).toISOString(),
  createdBy: "u1",
  hourlyLimit: 60,
  id: "conn-bob",
  inboundPolicy: "approve",
  inviteExpiresAt: null,
  lastInAt: null,
  lastOutAt: null,
  outboundPolicy: "approve",
  peerCardUrl: null,
  peerKind: "a2a_inbound",
  peerLabel: "Bob's agent",
  peerOrg: "Bob Co",
  peerOrigin: "https://bob.example",
  pendingOrigin: null,
  pendingTokenUrl: null,
  revokedAt: null,
  revokedBy: null,
  slug: "bob",
  status: "needs_approval",
  tokenPrefix: null,
  tokenUrl: null,
  toolPolicy: "ask",
  ...overrides,
});

test("a waiting A2A message and a pending connection wait in Needs you, the message unclipped", async () => {
  const text = "x".repeat(5000);
  waitingA2a = [bobMessage({ text })];
  connectionsA2a = [bobConnection()];

  const rail = await desk.railSources(user(), { dayStart: DAY_START });
  const message = rail.needsYou.find(
    (card) => card.needsYouKind === "a2a_message"
  );
  const wants = rail.needsYou.find(
    (card) => card.needsYouKind === "a2a_connection"
  );

  expect(message).toMatchObject({
    a2a: {
      checkCode: null,
      connectionId: "conn-bob",
      host: "bob.example",
      org: "Bob Co",
      peer: "Bob's agent",
      text,
    },
    agentId: a1,
    id: "task-1",
    kind: "request",
    lane: "needs_you",
    startedBy: "Bob's agent",
    title: "Bob's agent sent a message",
  });
  expect(message?.band.text).toBe(text);
  expect(wants).toMatchObject({
    a2a: {
      checkCode: "482913",
      connectionId: "conn-bob",
      host: "bob.example",
      org: "Bob Co",
      peer: "Bob's agent",
      text: null,
    },
    agentId: a1,
    id: "conn-bob",
    needsYouKind: "a2a_connection",
    startedBy: "Bob's agent",
    title: "Bob's agent wants to connect",
  });
  expect(wants?.band.text).toBe(
    "Bob's agent at bob.example wants to connect to Alpha. Check code 482913."
  );
  expect(await desk.needsYouCount(user())).toBe(2);
});

test("an active connection is not listed, and a message leaves Needs you once the source stops returning it", async () => {
  waitingA2a = [bobMessage()];
  connectionsA2a = [bobConnection({ status: "active" })];
  expect((await get()).needsYou.map((card) => card.needsYouKind)).toEqual([
    "a2a_message",
  ]);

  waitingA2a = [];

  expect((await get()).needsYou).toEqual([]);
  expect(await desk.needsYouCount(user())).toBe(0);
});

test("an A2A item for a draft agent is left out", async () => {
  const draft = await agents.createDraft(user(), { name: "Draft" });
  waitingA2a = [bobMessage({ agentId: draft.id })];
  connectionsA2a = [bobConnection({ agentId: draft.id })];

  expect((await get()).needsYou).toEqual([]);
  expect(await desk.needsYouCount(user())).toBe(0);
});

test("a message to an outside agent waits in Needs you with its open request, the peer in the title", async () => {
  const started = await runs.startRun(user(), {
    agentId: a1,
    input: { text: "ask Hermes" },
    session: { origin: "ui" },
  });
  await runs.claimRun(system, started.runId);
  const request = await requests.open(system, {
    input: {
      connection: "hermes",
      host: "h.example",
      peer: "Hermes",
      text: "Summarise the open pull requests.",
    },
    kind: "approval",
    runId: started.runId,
    toolKey: "a2a_send:con_1",
    toolName: "a2a_send",
    toolUseId: "a2a:aot_1",
  });

  const rail = await desk.railSources(user(), { dayStart: DAY_START });

  expect(rail.pending.map((record) => record.id)).toEqual([request.id]);
  expect(rail.needsYou).toHaveLength(1);
  expect(rail.needsYou[0]).toMatchObject({
    id: request.id,
    lane: "needs_you",
    needsYouKind: "approval",
    title: "Send a message to Hermes",
  });
});

test("only the current user app version has one grant card, regardless of grant count", async () => {
  const { artifacts, artifactVersions, artifactGrants } = await import(
    "@repo/db/schema/artifacts"
  );
  const at = new Date(NOW).toISOString();
  await db.insert(artifacts).values({
    audience: "private",
    createdAt: at,
    createdById: "u1",
    createdByKind: "user",
    currentVersionId: "v2",
    id: "app",
    kind: "app",
    ownerUserId: "u1",
    title: "Bot",
    updatedAt: at,
    workspaceId: "w1",
  });
  for (const number of [1, 2]) {
    // biome-ignore lint/performance/noAwaitInLoops: Insert each version before its grants.
    await db.insert(artifactVersions).values({
      artifactId: "app",
      authorId: "u1",
      authorKind: "user",
      createdAt: at,
      entry: "index.html",
      fileCount: 1,
      id: `v${number}`,
      manifestKey: "manifest",
      message: "",
      number,
      status: "published",
      totalBytes: 1,
      workspaceId: "w1",
    });
    for (const kind of ["endpoint", "host"] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Preserve parent-before-child fixture writes.
      await db.insert(artifactGrants).values({
        createdAt: at,
        id: `${number}-${kind}`,
        kind,
        status: "pending",
        target: kind === "host" ? "discord.com" : "discord",
        versionId: `v${number}`,
        workspaceId: "w1",
      });
    }
  }
  const rail = await desk.railSources(user(), { dayStart: DAY_START });
  expect(
    rail.needsYou.filter((card) => card.needsYouKind === "artifact_grant")
  ).toMatchObject([{ artifactId: "app", id: "v2" }]);
  expect(await desk.needsYouCount(user())).toBe(1);
});

for (const scenario of [
  "run",
  "rejected",
  "person",
  "person_without_pending",
  "current",
] as const) {
  test(`a newer ${scenario} version only hides a person's grant card when actionable or current`, async () => {
    const { artifacts, artifactVersions, artifactGrants } = await import(
      "@repo/db/schema/artifacts"
    );
    const at = new Date(NOW).toISOString();
    await db.insert(artifacts).values({
      audience: "private",
      createdAt: at,
      createdById: "u1",
      createdByKind: "user",
      currentVersionId: scenario === "current" ? "v2" : null,
      id: "app",
      kind: "app",
      ownerUserId: "u1",
      title: "Bot",
      updatedAt: at,
      workspaceId: "w1",
    });
    let newerStatus: "published" | "proposed" | "rejected" = "proposed";
    if (scenario === "current") {
      newerStatus = "published";
    }
    if (scenario === "rejected") {
      newerStatus = "rejected";
    }
    await db.insert(artifactVersions).values(
      [1, 2].map((number) => ({
        artifactId: "app",
        authorId: "u1",
        authorKind:
          number === 2 && scenario === "run"
            ? ("agent" as const)
            : ("user" as const),
        createdAt: at,
        entry: "index.html",
        fileCount: 1,
        id: `v${number}`,
        manifestKey: "manifest",
        message: "",
        number,
        status: number === 2 ? newerStatus : ("proposed" as const),
        totalBytes: 1,
        workspaceId: "w1",
      }))
    );
    await db.insert(artifactGrants).values(
      [1, 2].map((number) => ({
        createdAt: at,
        id: `g${number}`,
        kind: "host" as const,
        status:
          number === 2 && scenario === "person_without_pending"
            ? ("approved" as const)
            : ("pending" as const),
        target: "example.com",
        versionId: `v${number}`,
        workspaceId: "w1",
      }))
    );
    const rail = await desk.railSources(user(), { dayStart: DAY_START });
    const cards = rail.needsYou.filter(
      (card) => card.needsYouKind === "artifact_grant"
    );
    expect(cards.map((card) => card.id)).toEqual(
      scenario === "person" || scenario === "current" ? ["v2"] : ["v1"]
    );
    expect(cards[0]?.band.text).toBe(
      `Approve access for version ${scenario === "person" || scenario === "current" ? 2 : 1}`
    );
  });
}

test("a connector with a deleted secret reaches Needs you with admin guidance", async () => {
  await db.insert(connectors).values({
    authKind: "header",
    authMode: "header",
    createdAt: DAY_START,
    createdBy: "u1",
    headerTemplate: "Bearer {value}",
    id: "missing_secret",
    name: "Header",
    status: "needs_auth",
    url: "https://example.com/mcp",
    workspaceId: "w1",
  });
  await db.insert(agentConnectors).values({
    agentId: a1,
    connectorId: "missing_secret",
    createdAt: DAY_START,
    credentialMode: "agent",
    workspaceId: "w1",
  });
  const rail = await desk.railSources(user(), { dayStart: DAY_START });
  expect(rail.needsYou).toContainEqual(
    expect.objectContaining({
      band: {
        text: "Needs a secret. Ask an admin to link one in Authentication.",
        tone: "waiting",
      },
      id: "missing_secret",
      needsYouKind: "connector_secret",
    })
  );
  expect(await desk.needsYouCount(user())).toBe(rail.needsYou.length);
});

test("a person's update stacked on a lapsed run proposal does not break Needs you", async () => {
  const { skill } = await skillsStore.create(user(), {
    files: [
      {
        content: "---\nname: tidy\ndescription: Tidies up.\n---\n\n# tidy\n",
        path: "SKILL.md",
      },
    ],
    message: "Add tidy",
    name: "tidy",
  });
  const lapsed = new Date(now - SKILL_CHANGE_TTL_MS - 1000).toISOString();
  await db.insert(skillVersions).values([
    {
      authorId: a1,
      authorKind: "agent",
      createdAt: lapsed,
      id: "zz-run-change",
      message: "Run change",
      number: 2,
      parentNumber: 1,
      skillId: skill.id,
      status: "proposed",
      workspaceId: "w1",
    },
    {
      authorId: "u1",
      authorKind: "user",
      createdAt: lapsed,
      id: "zz-person-update",
      message: "Proposed update from GitHub",
      number: 3,
      parentNumber: 2,
      skillId: skill.id,
      status: "proposed",
      workspaceId: "w1",
    },
  ]);

  const rail = await desk.railSources(user(), { dayStart: DAY_START });

  expect(rail.needsYou).toEqual([]);
});
