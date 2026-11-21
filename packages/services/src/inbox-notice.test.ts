import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import {
  inboxPosts as inboxPostRows,
  inboxThreads as inboxThreadRows,
} from "@repo/db/schema/inbox";
import { runs as runRows } from "@repo/db/schema/runs";
import {
  teamMembers as teamMemberRows,
  teams as teamRows,
} from "@repo/db/schema/teams";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { asc, eq } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { HAND_OFF_HEADING, TEAM_DIARY_TOPIC } from "./dream/team/collect.ts";
import { createHandOffRetrier } from "./dream/team/hand-off-retry.ts";
import { ServiceError } from "./errors.ts";
import { createEventsService } from "./events.ts";
import { createInboxService, type InboxService } from "./inbox.ts";
import type { Clock, RuntimeAdapter } from "./runs/types.ts";
import { createRunsService, type RunsService } from "./runs.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "./workspaces.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";
const NOTICE_TITLE = "Dream diary";
const DIGEST = "Digest: the team agreed on the Q4 plan.";

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

let db: ReturnType<typeof migrated>;
let nowMs: number;
let clock: Clock;
let agents: AgentsService;
let runs: RunsService;
let inbox: InboxService;
let agentIds: Record<string, string>;

/** Runs nothing to completion, so a started run stays as it was dispatched. */
const heldRuntime = (): RuntimeAdapter => ({
  cancel: () => Promise.resolve(),
  dispatch: async (_db, run, _agent, deps) => {
    await deps.claimRun(SYSTEM_PRINCIPAL, run.id);
  },
  kind: "fake",
});

const build = (
  options: { roomDigest?: (teamId: string) => Promise<string | null> } = {}
) => {
  const atomic = sqliteAtomic(db);
  const blobs = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
  };
  const events = createEventsService({ blobs, db });
  agents = createAgentsService({ db, events });
  inbox = createInboxService({
    atomic,
    clock,
    db,
    events,
    roomDigest: options.roomDigest,
    runs: { startRun: (principal, input) => runs.startRun(principal, input) },
  });
  runs = createRunsService({
    adapters: [heldRuntime()],
    atomic,
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [inbox.gateway],
  });
};

const addAgents = async (...slugs: string[]) => {
  for (const slug of slugs) {
    // biome-ignore lint/performance/noAwaitInLoops: one agent at a time keeps the ids stable
    const agent = await agents.create(user, {
      model: "fake",
      name: slug,
      runtime: "fake",
      slug,
    });
    agentIds[slug] = agent.id;
  }
};

const agentId = (slug: string): string => {
  const id = agentIds[slug];
  if (!id) {
    throw new Error(`No agent ${slug}`);
  }
  return id;
};

const allRuns = () => db.select().from(runRows).orderBy(asc(runRows.id)).all();

const runsOf = (slug: string) =>
  allRuns().filter((run) => run.agentId === agentId(slug));

const postsOf = (threadId: string) =>
  db
    .select()
    .from(inboxPostRows)
    .where(eq(inboxPostRows.threadId, threadId))
    .orderBy(asc(inboxPostRows.id))
    .all();

const topicsTitled = (title: string) =>
  db
    .select()
    .from(inboxThreadRows)
    .where(eq(inboxThreadRows.title, title))
    .all();

interface TeamSeed {
  lead?: string;
  members: { agents?: string[]; users?: string[] };
}

/** A team in the workspace with its members. */
const seedTeam = (seed: TeamSeed): string => {
  const teamId = `team-${db.select().from(teamRows).all().length}`;
  db.insert(teamRows)
    .values({
      createdAt: START,
      id: teamId,
      leadAgentId: seed.lead ? agentId(seed.lead) : null,
      name: teamId,
      slug: teamId,
      workspaceId: WORKSPACE,
    })
    .run();
  const members = [
    ...(seed.members.users ?? []).map((id) => ({
      memberId: id,
      memberKind: "user" as const,
    })),
    ...(seed.members.agents ?? []).map((slug) => ({
      memberId: agentId(slug),
      memberKind: "agent" as const,
    })),
  ];
  for (const member of members) {
    db.insert(teamMemberRows)
      .values({ ...member, teamId, workspaceId: WORKSPACE })
      .run();
  }
  return teamId;
};

const notice = (
  teamId: string,
  overrides: Partial<{
    authorAgentId: string | null;
    text: string;
    title: string;
    wake: { agentId: string; asUserId: string };
  }> = {}
) =>
  inbox.postNotice(SYSTEM_PRINCIPAL, {
    authorAgentId: null,
    teamId,
    text: "Tonight's diary is in.",
    title: NOTICE_TITLE,
    ...overrides,
  });

beforeEach(() => {
  db = migrated();
  nowMs = Date.parse(START);
  clock = {
    now: () => new Date(nowMs),
    sleep: () => Promise.resolve(),
  };
  agentIds = {};
  for (const id of [WORKSPACE, "w2"]) {
    db.insert(workspaceRows)
      .values({
        clerkOrgId: `org_${id}`,
        createdAt: START,
        id,
        name: id,
        timezone: "UTC",
      })
      .run();
  }
});

test("a notice opens its topic once and the second notice reuses it", async () => {
  build();
  await addAgents("pelican");
  const teamId = seedTeam({ members: { users: ["u1"] } });

  const first = await notice(teamId);
  const second = await notice(teamId, { text: "Second entry." });

  expect(second.threadId).toBe(first.threadId);
  expect(topicsTitled(NOTICE_TITLE)).toHaveLength(1);
  expect(postsOf(first.threadId).map((post) => post.text)).toEqual([
    "Tonight's diary is in.",
    "Second entry.",
  ]);
});

test("a limited topic with the notice's title is not reused", async () => {
  build();
  await addAgents("pelican");
  const teamId = seedTeam({ members: { users: ["u1", "u2"] } });
  const limited = await inbox.createThread(user, {
    members: [{ id: "u2", kind: "user" }],
    teamId,
    title: NOTICE_TITLE,
  });

  const result = await notice(teamId);

  expect(result.threadId).not.toBe(limited.id);
  expect(topicsTitled(NOTICE_TITLE)).toHaveLength(2);
  expect(postsOf(limited.id)).toEqual([]);
});

test("the author is the agent when one is given, and the system user otherwise", async () => {
  build();
  await addAgents("pelican");
  const teamId = seedTeam({ members: { agents: ["pelican"], users: ["u1"] } });

  const byAgent = await notice(teamId, {
    authorAgentId: agentId("pelican"),
    title: "By agent",
  });
  const bySystem = await notice(teamId, { title: "By system" });

  expect(postsOf(byAgent.threadId)).toEqual([
    expect.objectContaining({
      authorId: agentId("pelican"),
      authorKind: "agent",
      runId: null,
      text: "Tonight's diary is in.",
    }),
  ]);
  expect(postsOf(bySystem.threadId)).toEqual([
    expect.objectContaining({
      authorId: "system",
      authorKind: "user",
      runId: null,
    }),
  ]);
  expect(topicsTitled("By agent")[0]?.openedByAgentId).toBe(agentId("pelican"));
});

test("a mention in a notice's text wakes nobody", async () => {
  build();
  await addAgents("pelican");
  const teamId = seedTeam({ members: { agents: ["pelican"], users: ["u1"] } });

  const result = await notice(teamId, { text: "@pelican please read this." });

  expect(result.runs).toEqual([]);
  expect(allRuns()).toEqual([]);
  expect(postsOf(result.threadId)).toHaveLength(1);
});

test("a person may not post a notice", async () => {
  build();
  await addAgents("pelican");
  const teamId = seedTeam({ members: { users: ["u1", "u2"] } });
  const refused = (principal: Principal) =>
    expect(
      inbox.postNotice(principal, {
        authorAgentId: null,
        teamId,
        text: "Not allowed.",
        title: NOTICE_TITLE,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);

  await Promise.all([refused(user), refused(colleague)]);
  expect(topicsTitled(NOTICE_TITLE)).toEqual([]);
});

test("with wake, the named lead's run starts with the notice text", async () => {
  build();
  await addAgents("pelican");
  const teamId = seedTeam({
    lead: "pelican",
    members: { agents: ["pelican"], users: ["u1"] },
  });

  const result = await notice(teamId, {
    wake: { agentId: agentId("pelican"), asUserId: "u1" },
  });

  const [run, ...others] = runsOf("pelican");
  expect(others).toEqual([]);
  expect(result.runs).toEqual([
    { agentId: agentId("pelican"), runId: run?.id ?? "" },
  ]);
  expect(run?.inputText.startsWith("Tonight's diary is in.")).toBe(true);
  expect(run).toMatchObject({ actorId: "u1", onBehalfOfUserId: "u1" });
});

test("with wake, an agent outside the team is not woken", async () => {
  build();
  await addAgents("pelican");
  const teamId = seedTeam({ lead: "pelican", members: { users: ["u1"] } });

  const result = await notice(teamId, {
    wake: { agentId: agentId("pelican"), asUserId: "u1" },
  });

  expect(result.runs).toEqual([]);
  expect(allRuns()).toEqual([]);
});

test("the room digest is in the wake input of a mention", async () => {
  const digestedTeams: string[] = [];
  build({
    roomDigest: (digestTeamId) => {
      digestedTeams.push(digestTeamId);
      return Promise.resolve(DIGEST);
    },
  });
  await addAgents("pelican");
  const teamId = seedTeam({ members: { agents: ["pelican"], users: ["u1"] } });
  const threadId = (await inbox.createThread(user, { teamId, title: "Plans" }))
    .id;

  await inbox.post(user, { text: "@pelican hi", threadId });

  const [run] = runsOf("pelican");
  expect(run?.inputText).toContain(DIGEST);
  expect(digestedTeams).toEqual([teamId]);
});

test("a throwing room digest does not stop the wake", async () => {
  build({
    roomDigest: () => Promise.reject(new Error("digest store is down")),
  });
  await addAgents("pelican");
  const teamId = seedTeam({ members: { agents: ["pelican"], users: ["u1"] } });
  const threadId = (await inbox.createThread(user, { teamId, title: "Plans" }))
    .id;

  const result = await inbox.post(user, { text: "@pelican hi", threadId });

  expect(result.runs).toHaveLength(1);
  const [run] = runsOf("pelican");
  expect(run?.inputText.startsWith("@pelican hi")).toBe(true);
  expect(run?.inputText).not.toContain("Room digest");
});

test("a hand-off request refused for the wake budget wakes the lead on a later tick, once", async () => {
  build();
  await addAgents("pelican");
  const teamId = seedTeam({
    lead: "pelican",
    members: { agents: ["pelican"], users: ["u1"] },
  });
  db.update(teamRows)
    .set({ ownerUserId: "u1" })
    .where(eq(teamRows.id, teamId))
    .run();
  await runs.startRun(user, {
    agentId: agentId("pelican"),
    input: { text: "Earlier wake" },
    session: { externalKey: "earlier", origin: "inbox" },
  });
  const [original] = runsOf("pelican");
  if (!original) {
    throw new Error("No earlier wake");
  }
  for (let index = 1; index < 10; index += 1) {
    db.insert(runRows)
      .values({ ...original, id: `earlier-${index}` })
      .run();
  }
  // The earlier runs are finished, so the retried wake can claim its own.
  db.update(runRows).set({ status: "done" }).run();
  const retrier = createHandOffRetrier({ clock, db, inbox });

  nowMs += 1000;
  const request = await notice(teamId, {
    text: `${HAND_OFF_HEADING}\nTally redid Quill's lists.`,
    title: TEAM_DIARY_TOPIC,
    wake: { agentId: agentId("pelican"), asUserId: "u1" },
  });
  expect(request.runs).toEqual([]);
  expect(postsOf(request.threadId)).toHaveLength(1);
  expect(runsOf("pelican")).toHaveLength(10);

  nowMs += 60_000;
  expect(await retrier.retry()).toEqual({ woken: [] });
  expect(runsOf("pelican")).toHaveLength(10);
  expect(
    db
      .select()
      .from(eventRows)
      .where(eq(eventRows.type, "inbox.loop_stopped"))
      .all()
  ).toHaveLength(1);

  nowMs += 60 * 60_000;
  expect(await retrier.retry()).toEqual({ woken: [request.postId] });
  expect(runsOf("pelican")).toHaveLength(11);
  expect(
    runsOf("pelican").filter((run) => run.inputText.includes(HAND_OFF_HEADING))
  ).toHaveLength(1);

  nowMs += 60_000;
  expect(await retrier.retry()).toEqual({ woken: [] });
  expect(runsOf("pelican")).toHaveLength(11);
});

test("two refused hand-off requests are answered by one retried wake that carries both, and a refusal that is not the budget records nothing", async () => {
  build();
  await addAgents("pelican");
  const teamId = seedTeam({
    lead: "pelican",
    members: { agents: ["pelican"], users: ["u1"] },
  });
  db.update(teamRows)
    .set({ ownerUserId: "u1" })
    .where(eq(teamRows.id, teamId))
    .run();
  const retrier = createHandOffRetrier({ clock, db, inbox });
  const stops = () =>
    db
      .select()
      .from(eventRows)
      .where(eq(eventRows.type, "inbox.loop_stopped"))
      .all();
  const ask = (text: string) =>
    notice(teamId, {
      text: `${HAND_OFF_HEADING}\n${text}`,
      title: TEAM_DIARY_TOPIC,
    });
  await ask("First rework.");
  nowMs += 1000;
  const second = await ask("Second rework.");

  // The run service refuses the wake, and the refusal is not recorded.
  const real = runs;
  runs = {
    ...real,
    startRun: () =>
      Promise.reject(new ServiceError("conflict", "The agent is busy")),
  };
  expect(await retrier.retry()).toEqual({ woken: [] });
  expect(stops()).toEqual([]);
  runs = real;

  nowMs += 1000;
  expect(await retrier.retry()).toEqual({ woken: [second.postId] });
  const [run, ...others] = runsOf("pelican");
  expect(others).toEqual([]);
  expect(run?.inputText).toContain("First rework.");
  expect(run?.inputText).toContain("Second rework.");
});

test("a member's look-alike hand-off post wakes nobody, and the system's own post still gets its one retry", async () => {
  build();
  await addAgents("pelican", "quill");
  const teamId = seedTeam({
    lead: "pelican",
    members: { agents: ["pelican", "quill"], users: ["u1", "u2"] },
  });
  db.update(teamRows)
    .set({ ownerUserId: "u1" })
    .where(eq(teamRows.id, teamId))
    .run();
  const retrier = createHandOffRetrier({ clock, db, inbox });
  const diary = await notice(teamId, {
    text: "Diary",
    title: TEAM_DIARY_TOPIC,
  });
  nowMs += 1000;
  // Addressed to another agent, so the lead does not hear it as a mention.
  const lookAlike = await inbox.post(colleague, {
    text: `${HAND_OFF_HEADING} @quill please look`,
    threadId: diary.threadId,
  });
  nowMs += 60_000;
  expect(await retrier.retry()).toEqual({ woken: [] });
  // The second guard: the wake itself refuses a post the system did not write.
  expect(
    await inbox.retryNoticeWake(SYSTEM_PRINCIPAL, lookAlike.post.id, {
      agentId: agentId("pelican"),
      asUserId: "u1",
    })
  ).toEqual([]);
  expect(runsOf("pelican")).toEqual([]);

  const request = await notice(teamId, {
    text: `${HAND_OFF_HEADING}\nTally redid Quill's lists.`,
    title: TEAM_DIARY_TOPIC,
  });
  nowMs += 60_000;
  expect(await retrier.retry()).toEqual({ woken: [request.postId] });
  expect(runsOf("pelican")).toHaveLength(1);
  expect(runsOf("pelican")[0]?.onBehalfOfUserId).toBe("u1");
});
