import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { dreamQuestions, dreamRuns } from "@repo/db/schema/dreams";
import { teamMembers, teams } from "@repo/db/schema/teams";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createMasker } from "@repo/protocol/masker";
import { eq } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { createDeskService, type DeskInput } from "./desk.ts";
import { storeOptions } from "./dream/question-options.ts";
import { createEventsService } from "./events.ts";
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
import type { Principal } from "./workspaces.ts";

const user = (userId = "u1", workspaceId = "w1"): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});
const DAY_START = "2026-10-26T00:00:00.000Z";
const NOW = Date.parse("2026-10-26T09:00:00Z");

const TEAM = "team1";
const AGENT_RUN = "dream-agent";
const TEAM_RUN = "dream-team";
const QUESTION = "q1";
const DREAM_OPTIONS = [
  { noteId: "n1", text: "The deploy is on Fridays" },
  { noteId: "n2", text: "The deploy is on Mondays" },
];

let db: ReturnType<typeof migrated>;
let agents: AgentsService;
let desk: ReturnType<typeof createDeskService>;
/** The agent the team's dream and questions run through, named "Alpha". */
let a1: string;
/** A second agent, named "Beta". */
let a2: string;

const get = (input: Partial<DeskInput> = {}, principal = user()) =>
  desk.get(principal, { dayStart: DAY_START, ...input });

const ids = (cards: { id: string }[]) => cards.map((card) => card.id);

beforeEach(async () => {
  db = migrated();
  const iso = new Date(NOW).toISOString();
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
    now: () => new Date(NOW),
    sleep: () => Promise.resolve(),
  };
  const blobs = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
  };
  const atomic = sqliteAtomic(db);
  const events = createEventsService({ blobs, db });
  const adapter: RuntimeAdapter = {
    cancel: () => Promise.resolve(),
    dispatch: () => Promise.resolve(),
    kind: "cloud",
    resume: () => Promise.resolve(),
  };
  const runs = createRunsService({
    adapters: [adapter],
    atomic,
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
  });
  const requests = createRequestsService({
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
  const skillsStore = createSkillsStoreService({
    atomic,
    blobs: memorySkillBlobs(),
    clock,
    db,
    events,
    library,
  });
  const triggers = createTriggersService({ clock, db, events, runs });
  const routines = createRoutinesService({ clock, db, events, runs });
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
  await make("Other", "w2");
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
    routines,
    skillsStore,
    triggers,
  });
});

const insertAgentRun = () =>
  db.insert(dreamRuns).values({
    agentId: a1,
    id: AGENT_RUN,
    startedAt: new Date(NOW).toISOString(),
    status: "done",
    workspaceId: "w1",
  });

const insertTeamRun = () =>
  db.insert(dreamRuns).values({
    agentId: null,
    id: TEAM_RUN,
    startedAt: new Date(NOW).toISOString(),
    status: "done",
    teamId: TEAM,
    workspaceId: "w1",
  });

const insertTeam = (row: Partial<typeof teams.$inferInsert> = {}) =>
  db.insert(teams).values({
    createdAt: new Date(NOW).toISOString(),
    id: TEAM,
    name: "Crew",
    ownerUserId: "u1",
    slug: "crew",
    workspaceId: "w1",
    ...row,
  });

const addAgentMember = (memberId: string) =>
  db.insert(teamMembers).values({
    memberId,
    memberKind: "agent",
    teamId: TEAM,
    workspaceId: "w1",
  });

const questionRow = (
  row: Partial<typeof dreamQuestions.$inferInsert> = {}
): typeof dreamQuestions.$inferInsert => ({
  agentId: null,
  createdAt: new Date(NOW).toISOString(),
  dreamRunId: TEAM_RUN,
  id: QUESTION,
  options: storeOptions(DREAM_OPTIONS, null),
  question: "When is the deploy?",
  status: "open",
  teamId: TEAM,
  workspaceId: "w1",
  ...row,
});

/** A team led by `a2`, with `a1` as its only agent member, and one open question. */
const seedTeamQuestion = async () => {
  await insertTeam({ leadAgentId: a2 });

  await insertTeamRun();
  await addAgentMember(a1);
  await db.insert(dreamQuestions).values(questionRow());
};

test("the team owner sees a team question as a dream question card, started by the lead", async () => {
  await seedTeamQuestion();

  const cards = (await get()).needsYou;

  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    agentId: a2,
    dream: {
      options: DREAM_OPTIONS,
      question: "When is the deploy?",
      questionId: QUESTION,
    },
    id: QUESTION,
    kind: "proposal",
    needsYouKind: "dream_question",
    startedBy: "Beta",
    title: "When is the deploy?",
  });
  expect(cards[0]).not.toHaveProperty("forUserId");
  expect(await desk.needsYouCount(user())).toBe(1);
});

test("an org admin sees a team question", async () => {
  await seedTeamQuestion();
  const admin = { ...user("u2"), isAdmin: true };

  expect(ids((await get({}, admin)).needsYou)).toEqual([QUESTION]);
  expect(await desk.needsYouCount(admin)).toBe(1);
});

test("another member does not see a team question", async () => {
  await seedTeamQuestion();

  expect((await get({}, user("u2"))).needsYou).toEqual([]);
  expect(await desk.needsYouCount(user("u2"))).toBe(0);
});

test("a team with no lead asks through its lowest-id agent member", async () => {
  await insertTeam();

  await insertTeamRun();
  // Inserted out of id order, so the answer does not depend on insert order.
  const [lowest, highest] = [a1, a2].sort();
  await addAgentMember(highest as string);
  await addAgentMember(lowest as string);
  await db.insert(dreamQuestions).values(questionRow());

  const [card] = (await get()).needsYou;

  expect(card?.agentId).toBe(lowest);
});

test("a team whose lead is not active asks through its agent member", async () => {
  await insertTeam({ leadAgentId: a2 });

  await insertTeamRun();
  await addAgentMember(a1);
  await db
    .update(agentRows)
    .set({ status: "archived" })
    .where(eq(agentRows.id, a2));
  await db.insert(dreamQuestions).values(questionRow());

  const [card] = (await get()).needsYou;

  expect(card?.agentId).toBe(a1);
});

test("a team with no active agent member shows no card", async () => {
  await insertTeam();

  await insertTeamRun();
  await db.insert(teamMembers).values({
    memberId: "u1",
    memberKind: "user",
    teamId: TEAM,
    workspaceId: "w1",
  });
  await db.insert(dreamQuestions).values(questionRow());

  expect((await get()).needsYou).toEqual([]);
  expect(await desk.needsYouCount(user())).toBe(0);
});

test("an archived team shows no card", async () => {
  await insertTeam({
    archivedAt: new Date(NOW).toISOString(),
    leadAgentId: a2,
  });

  await insertTeamRun();
  await addAgentMember(a1);
  await db.insert(dreamQuestions).values(questionRow());

  expect((await get()).needsYou).toEqual([]);
  expect(await desk.needsYouCount(user())).toBe(0);
});

test("an answered team question leaves Needs you", async () => {
  await seedTeamQuestion();
  await db
    .update(dreamQuestions)
    .set({ status: "answered" })
    .where(eq(dreamQuestions.id, QUESTION));

  expect((await get()).needsYou).toEqual([]);
});

test("a team question about a private note shows only to its person", async () => {
  await insertTeam({ leadAgentId: a2, ownerUserId: "u3" });

  await insertTeamRun();
  await addAgentMember(a1);
  await db
    .insert(dreamQuestions)
    .values(questionRow({ options: storeOptions(DREAM_OPTIONS, "u3") }));

  expect(ids((await get({}, user("u3"))).needsYou)).toEqual([QUESTION]);
  expect((await get({}, user("u3"))).needsYou[0]).toMatchObject({
    forUserId: "u3",
  });
  expect((await get({}, user("u1"))).needsYou).toEqual([]);
});

test("an agent question still goes to its agent and shows to its owner", async () => {
  await insertAgentRun();
  await db.insert(dreamQuestions).values({
    agentId: a1,
    createdAt: new Date(NOW).toISOString(),
    dreamRunId: AGENT_RUN,
    id: "q-agent",
    options: storeOptions(DREAM_OPTIONS, null),
    question: "When is the deploy?",
    status: "open",
    workspaceId: "w1",
  });

  const cards = (await get()).needsYou;

  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    agentId: a1,
    id: "q-agent",
    needsYouKind: "dream_question",
  });
});

test("a team question card carries the team's name and an agent question does not", async () => {
  await seedTeamQuestion();
  await insertAgentRun();
  await db.insert(dreamQuestions).values({
    agentId: a1,
    createdAt: new Date(NOW).toISOString(),
    dreamRunId: AGENT_RUN,
    id: "q-agent",
    options: storeOptions(DREAM_OPTIONS, null),
    question: "When is the deploy?",
    status: "open",
    workspaceId: "w1",
  });

  const cards = (await get()).needsYou;

  expect(cards.find((card) => card.id === QUESTION)?.dream?.teamName).toBe(
    "Crew"
  );
  expect(cards.find((card) => card.id === "q-agent")?.dream).not.toHaveProperty(
    "teamName"
  );
});
