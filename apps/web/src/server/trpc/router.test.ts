import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runs } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  DEFAULT_NEVER_REMEMBER,
  DEFAULT_REMEMBER_RULES,
  defaultAgentAvatar,
} from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { NO_KEY_MESSAGE } from "@repo/services/managed/keys";
import { systemClock } from "@repo/services/runs/types";
import { eq } from "drizzle-orm";
import { composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ORG_IDS = ["org_a"];

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated(ORG_IDS);
});

const infra = (): Infra => {
  const store = new Map<string, string>();
  return {
    atomic: sqliteAtomic(db),
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    clock: systemClock,
    devFakeRuntime: true,
    fileBlobs: memoryFileBlobs(),
    relay: noopRelay,
  };
};

const callerFor = async (session: {
  orgId?: string | null;
  orgRole?: string | null;
  userId: string | null;
}) =>
  appRouter.createCaller(
    await buildContext({
      composed: composeWith({
        db,
        infra: infra(),
      }),
      session,
    })
  );

const workspaceRows = (clerkOrgId: string) =>
  db
    .select()
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, clerkOrgId))
    .all();

test("me returns the user and the workspace row of the active org", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  const me = await caller.me();
  const [row] = workspaceRows("org_a");
  if (!row) {
    throw new Error("org_a has no workspace row");
  }
  expect(me).toEqual({ userId: "user_1", workspaceId: row.id });
});

test("calling me again keeps one workspace row", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const first = await caller.me();
  const second = await caller.me();
  expect(second).toEqual(first);
  expect(workspaceRows("org_a")).toHaveLength(1);
});

test("signed out, no org, and an org with no workspace row are all 401", async () => {
  await expect(
    (await callerFor({ orgId: "org_a", userId: null })).me()
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

  await expect(
    (await callerFor({ orgId: null, userId: "user_1" })).me()
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

  await expect(
    (await callerFor({ orgId: "org_b", userId: "user_1" })).me()
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(workspaceRows("org_b")).toHaveLength(0);
});

test("the first request by a member of an unknown org creates no row", async () => {
  const caller = await callerFor({ orgId: "org_new", userId: "user_1" });
  await expect(caller.me()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.me()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(workspaceRows("org_new")).toHaveLength(0);
  expect(db.select().from(workspaces).all()).toHaveLength(1);
});

const agentInput = {
  model: "fake",
  name: "Fake echo",
  runtime: "fake",
} as const;

test("agents.create then runs.start runs the echo end to end", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);
  expect(await caller.agents.list({})).toEqual([agent]);

  const started = await caller.runs.start({
    agentId: agent.id,
    input: { text: "hi" },
    session: { origin: "ui" },
  });
  const run = await caller.runs.get({ runId: started.runId });
  expect(run.status).toBe("done");
  expect(run.resultText).toBe("Echo: hi");
  const [row] = db.select().from(runs).all();
  expect(row?.onBehalfOfUserId).toBe("user_1");
});

test("service errors keep their meaning over tRPC", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);

  await expect(caller.agents.create(agentInput)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  await expect(caller.agents.get({ id: "missing" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(
    caller.runs.start({
      agentId: agent.id,
      input: { fileIds: ["nope"], text: "hi" },
      session: { origin: "ui" },
    })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.runs.start({
      agentId: agent.id,
      input: { text: "" },
      session: { origin: "ui" },
    })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("roster.list returns one idle card per active agent, with an avatar from the name", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);

  expect(await caller.roster.list()).toEqual([
    {
      avatar: defaultAgentAvatar(agentInput.name),
      costThisWeekCents: 0,
      doneAt: null,
      id: agent.id,
      isLead: false,
      jobLine: "",
      learnedCount: 0,
      name: agentInput.name,
      needsYouCount: 0,
      ownerName: "",
      slug: agent.slug,
      state: "idle",
      statusLine: "Idle",
      teamId: null,
      weeklyCapCents: null,
    },
  ]);
});

test("roster.list is 401 without a workspace", async () => {
  await expect(
    (await callerFor({ orgId: null, userId: "user_1" })).roster.list()
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("keys.forAgent returns the five empty parts", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);

  expect(await caller.keys.forAgent({ agentId: agent.id })).toEqual({
    apps: [],
    asksBefore: { level: "rarely", overrides: [] },
    identity: { emailAddress: null, slackApp: null },
    otherAgents: { connections: [], handsTo: [] },
    secrets: [],
  });
});

test("keys.forAgent is 401 without a workspace", async () => {
  await expect(
    (await callerFor({ orgId: null, userId: "user_1" })).keys.forAgent({
      agentId: "any",
    })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("catalog lists apps, adds idempotently and refuses unknown keys", async () => {
  const caller = await callerFor({
    orgId: "org_a",
    orgRole: "org:admin",
    userId: "user_1",
  });

  const entries = await caller.catalog.list();
  expect(entries.length).toBeGreaterThan(0);
  const first = await caller.catalog.add({ key: "gmail" });
  expect(await caller.catalog.add({ key: "gmail" })).toEqual(first);
  await expect(caller.catalog.add({ key: "nope" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("catalog.add refuses a non-admin session", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  await expect(caller.catalog.add({ key: "gmail" })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});

test("catalog.list is 401 without a workspace", async () => {
  await expect(
    (await callerFor({ orgId: null, userId: "user_1" })).catalog.list()
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("jobs.list and jobs.forAgent are empty for a workspace with no jobs", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);

  expect(await caller.jobs.list()).toEqual([]);
  expect(await caller.jobs.forAgent({ agentId: agent.id })).toEqual([]);
});

test("jobs.draft needs a workspace key and jobs.runNow finds no job", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);

  await expect(
    caller.jobs.draft({
      agentId: agent.id,
      text: "Every Friday send the digest",
    })
  ).rejects.toMatchObject({ code: "BAD_REQUEST", message: NO_KEY_MESSAGE });
  await expect(caller.jobs.runNow({ jobId: "nope" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("jobs procedures are 401 without a workspace", async () => {
  const caller = await callerFor({ orgId: null, userId: "user_1" });

  await expect(caller.jobs.list()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.jobs.forAgent({ agentId: "any" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.jobs.draft({ agentId: "any", text: "x" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.jobs.runNow({ jobId: "any" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("memory.list and memory.changes are empty for a new agent", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);

  expect(await caller.memory.list({ agentId: agent.id })).toEqual([]);
  expect(await caller.memory.changes({ agentId: agent.id })).toEqual([]);
});

test("memory.rules.get returns the default rules", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);

  expect(await caller.memory.rules.get({ agentId: agent.id })).toEqual({
    agent: DEFAULT_REMEMBER_RULES,
    workspaceNever: [...DEFAULT_NEVER_REMEMBER],
  });
});

test("memory edit, forget, decide and undo are NOT_FOUND for ids that do not exist", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);

  await expect(
    caller.memory.edit({ agentId: agent.id, noteId: "note_1", text: "Tea" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.memory.forget({ agentId: agent.id, noteId: "note_1" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.memory.decide({ changeId: "change_1", decision: "approve" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.memory.undo({ changeId: "change_1" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.memory.add({ agentId: "missing", kind: "people", text: "Tea" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a person adds a note, sees it, and undoes it through the router", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);

  const change = await caller.memory.add({
    agentId: agent.id,
    kind: "people",
    text: "Tea",
  });

  expect(change).toMatchObject({ status: "applied", writtenBy: "person" });
  expect(await caller.memory.list({ agentId: agent.id })).toEqual([
    expect.objectContaining({ id: change.noteId, text: "Tea" }),
  ]);
  expect(await caller.memory.changes({ agentId: agent.id })).toEqual([change]);
  await caller.memory.undo({ changeId: change.id });
  expect(await caller.memory.list({ agentId: agent.id })).toEqual([]);
});

test("the agent's creator sets its remember rules through the router", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);
  const rules = { ...DEFAULT_REMEMBER_RULES, learnLevel: "ask_first" } as const;

  await caller.memory.rules.set({ agentId: agent.id, rules });

  expect((await caller.memory.rules.get({ agentId: agent.id })).agent).toEqual(
    rules
  );
});

test("memory.add with empty text is BAD_REQUEST", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(
    caller.memory.add({ agentId: "any", kind: "people", text: "" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("memory procedures are 401 without a workspace", async () => {
  const caller = await callerFor({ orgId: null, userId: "user_1" });
  const agentId = "any";

  await expect(caller.memory.list({ agentId })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.memory.changes({ agentId })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.memory.add({ agentId, kind: "people", text: "Tea" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.memory.edit({ agentId, noteId: "note_1", text: "Tea" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.memory.forget({ agentId, noteId: "note_1" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.memory.decide({ changeId: "change_1", decision: "approve" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.memory.undo({ changeId: "change_1" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.memory.rules.get({ agentId })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.memory.rules.set({ agentId, rules: DEFAULT_REMEMBER_RULES })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("spend.workspace and spend.byAgent are empty while nothing is spent", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);
  const range = { from: "2026-11-16", to: "2026-11-22" };

  expect(await caller.spend.workspace(range)).toEqual([]);
  expect(await caller.spend.byAgent({ agentId: agent.id, ...range })).toEqual(
    []
  );
});

test("spend.setCap and spend.resume change the caps and the pause through the router", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const admin = await callerFor({
    orgId: "org_a",
    orgRole: "org:admin",
    userId: "user_2",
  });
  const agent = await caller.agents.create(agentInput);

  expect(
    await caller.spend.setCap({ agentId: agent.id, weeklyCapCents: 5000 })
  ).toEqual({ agentId: agent.id, weeklyCapCents: 5000 });
  await expect(
    caller.spend.setCap({ agentId: null, weeklyCapCents: 9000 })
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(
    await admin.spend.setCap({ agentId: null, weeklyCapCents: 9000 })
  ).toEqual({ agentId: null, weeklyCapCents: 9000 });
  expect(
    await caller.spend.resume({ agentId: agent.id, weeklyCapCents: 8000 })
  ).toEqual({ pausedAt: null, pausedReason: null, weeklyCapCents: 8000 });
  await expect(caller.spend.resume({ agentId: "nope" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(await caller.spend.caps()).toEqual({
    agents: [
      {
        agentId: agent.id,
        pausedAt: null,
        pausedReason: null,
        weeklyCapCents: 8000,
      },
    ],
    workspaceCapCents: 9000,
  });
});

test("spend.caps has no workspace cap and no agent entries yet", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  expect(await caller.spend.caps()).toEqual({
    agents: [],
    workspaceCapCents: null,
  });
});

test("spend inputs that are not days or positive cents are BAD_REQUEST", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);

  await expect(
    caller.spend.workspace({ from: "yesterday", to: "2026-11-22" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.spend.workspace({ from: "2026-13-45", to: "2026-11-22" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.spend.workspace({ from: "2026-11-22", to: "2026-11-16" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.spend.byAgent({
      agentId: agent.id,
      from: "2026-11-22",
      to: "2026-11-16",
    })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.spend.setCap({ agentId: agent.id, weeklyCapCents: 0 })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.spend.resume({ agentId: agent.id, weeklyCapCents: 0 })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("spend procedures are 401 without a workspace", async () => {
  const caller = await callerFor({ orgId: null, userId: "user_1" });
  const range = { from: "2026-11-16", to: "2026-11-22" };

  await expect(caller.spend.workspace(range)).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.spend.byAgent({ agentId: "any", ...range })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.spend.setCap({ agentId: "any", weeklyCapCents: 5000 })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.spend.resume({ agentId: "any" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.spend.caps()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("teams.list is empty and teams.profiles.get is null while no team exists", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  expect(await caller.teams.list()).toEqual([]);
  expect(await caller.teams.profiles.get({})).toBeNull();
});

test("teams missing ids are NOT_FOUND and writes persist real teams and profiles", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(caller.teams.get({ teamId: "t1" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  const team = await caller.teams.create({ name: "Ops" });
  expect(team).toMatchObject({
    folderPath: "teams/ops",
    name: "Ops",
    ownerUserId: "user_1",
  });
  expect(await caller.teams.get({ teamId: team.id })).toEqual(team);
  expect(await caller.teams.list()).toContainEqual(team);
  await expect(
    caller.teams.update({ name: "X", teamId: "t1" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(caller.teams.archive({ teamId: "t1" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(
    caller.teams.addMember({
      memberId: "a1",
      memberKind: "agent",
      teamId: "t1",
    })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.teams.removeMember({
      memberId: "a1",
      memberKind: "agent",
      teamId: "t1",
    })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.teams.setLead({ agentId: null, teamId: "t1" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.teams.setRules({ rules: "r", teamId: "t1" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(
    await caller.teams.profiles.set({ handle: "dom", name: "Dom" })
  ).toEqual({
    handle: "dom",
    name: "Dom",
    userId: "user_1",
  });
  expect(await caller.teams.profiles.get({})).toMatchObject({ handle: "dom" });
});

test("teams inputs that are not valid are BAD_REQUEST", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(caller.teams.create({ name: "" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(
    caller.teams.addMember({
      memberId: "a1",
      memberKind: "robot" as "agent",
      teamId: "t1",
    })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.teams.profiles.set({ handle: "Bad Handle", name: "Dom" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("teams procedures are 401 without a workspace", async () => {
  const caller = await callerFor({ orgId: null, userId: "user_1" });
  const teamId = "t1";

  await expect(caller.teams.list()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.teams.get({ teamId })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.teams.create({ name: "Ops" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.teams.update({ name: "X", teamId })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.teams.archive({ teamId })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.teams.addMember({ memberId: "a1", memberKind: "agent", teamId })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.teams.removeMember({ memberId: "a1", memberKind: "agent", teamId })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.teams.setLead({ agentId: null, teamId })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.teams.setRules({ rules: "r", teamId })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.teams.profiles.get({})).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.teams.profiles.set({ handle: "dom", name: "Dom" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("dream.list is empty while the stub lists no runs", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  expect(await caller.dream.list({ agentId: "a1" })).toEqual([]);
});

test("dream changes are NOT_FOUND while the stub changes nothing", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(caller.dream.get({ dreamRunId: "d1" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(caller.dream.runNow({ agentId: "a1" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(caller.dream.undo({ dreamRunId: "d1" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(
    caller.dream.changes({ dreamRunId: "d1" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.dream.decide({ decision: "approve", dreamRunId: "d1" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.dream.answer({ noteId: "n1", questionId: "q1" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("team extras procedures: an unknown team is not found, and the decision queue is still a stub", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(caller.memory.listTeam({ teamId: "t1" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(caller.dream.runTeamNow({ teamId: "t1" })).rejects.toMatchObject(
    { code: "NOT_FOUND" }
  );
  await expect(
    caller.requests.answerDecisions({
      decisions: { q1: "Yes" },
      requestId: "r1",
    })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.requests.dismissDecisions({ requestId: "r1" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(caller.memory.listTeam({ teamId: "" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(caller.dream.runTeamNow({ teamId: "" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(
    caller.requests.answerDecisions({ requestId: "r1" } as never)
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.requests.dismissDecisions({ requestId: "" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("dream inputs that are not valid are BAD_REQUEST", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(caller.dream.list({ agentId: "" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(caller.dream.runNow({ agentId: "" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(caller.dream.get({ dreamRunId: "" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(caller.dream.undo({ dreamRunId: "" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(
    caller.dream.list({ agentId: "a1", extra: true } as never)
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.dream.decide({ decision: "maybe", dreamRunId: "d1" } as never)
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.dream.answer({ noteId: "", questionId: "q1" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("dream procedures are 401 without a workspace", async () => {
  const caller = await callerFor({ orgId: null, userId: "user_1" });

  await expect(caller.dream.list({ agentId: "a1" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.dream.get({ dreamRunId: "d1" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.dream.runNow({ agentId: "a1" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.dream.undo({ dreamRunId: "d1" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.dream.changes({ dreamRunId: "d1" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.dream.decide({ decision: "reject", dreamRunId: "d1" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.dream.answer({ noteId: "n1", questionId: "q1" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
