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

test("catalog.list is empty and catalog.add refuses an unknown key", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  expect(await caller.catalog.list()).toEqual([]);
  await expect(caller.catalog.add({ key: "nope" })).rejects.toMatchObject({
    code: "NOT_FOUND",
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

test("memory writes are NOT_FOUND while nothing is stored", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);

  await expect(
    caller.memory.add({ agentId: agent.id, kind: "people", text: "Tea" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
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
    caller.memory.rules.set({
      agentId: agent.id,
      rules: DEFAULT_REMEMBER_RULES,
    })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
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

test("spend.setCap and spend.resume are NOT_FOUND while the stub changes nothing", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);

  await expect(
    caller.spend.setCap({ agentId: agent.id, weeklyCapCents: 5000 })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.spend.setCap({ agentId: null, weeklyCapCents: null })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.spend.resume({ agentId: agent.id })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller.spend.resume({ agentId: agent.id, weeklyCapCents: 8000 })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
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
