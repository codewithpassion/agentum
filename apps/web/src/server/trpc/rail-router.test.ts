import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import type { MemberLister } from "@repo/services/members";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ALLOWED_ORG_IDS = ["org_a"];
const DAY_START = "2026-10-26T00:00:00.000Z";
const AGENT = { model: "m", name: "Rail agent", runtime: "fake" } as const;

let db: ReturnType<typeof migrated>;
let listedOrgs: string[];

beforeEach(() => {
  db = migrated();
  listedOrgs = [];
});

const fakeMembers: MemberLister = (clerkOrgId) => {
  listedOrgs.push(clerkOrgId);
  return Promise.resolve([
    { name: "Zoe Berg", userId: "user_2" },
    { name: "Ann Adler", userId: "user_1" },
  ]);
};

const infra = (withMembers = true): Infra => {
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
    ...(withMembers ? { members: fakeMembers } : {}),
  };
};

const servicesFor = (withMembers = true): Composed =>
  composeWith({
    allowedOrgIds: ALLOWED_ORG_IDS,
    db,
    infra: infra(withMembers),
  });

const callerFor = async (
  session: { orgId?: string | null; userId: string | null },
  composed: Composed = servicesFor()
) => appRouter.createCaller(await buildContext({ composed, session }));

test("a caller without a session gets UNAUTHORIZED on the rail procedures", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(
    caller.desk.rail({ dayStart: DAY_START, scope: "mine" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.desk.clearAttention({ runId: "run_1" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.members.list()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.agents.setOwners({
      backupUserId: null,
      id: "agent_1",
      ownerUserId: null,
    })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("a caller with a user but no org gets UNAUTHORIZED on the rail procedures", async () => {
  const caller = await callerFor({ orgId: null, userId: "user_1" });

  await expect(
    caller.desk.rail({ dayStart: DAY_START, scope: "everyone" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    caller.desk.clearAttention({ runId: "run_1" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.members.list()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("desk.rail rejects a dayStart that is not an ISO time", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(
    caller.desk.rail({ dayStart: "yesterday", scope: "mine" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("desk.rail rejects a scope that is neither mine nor everyone", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(
    caller.desk.rail({ dayStart: DAY_START, scope: "team" as "mine" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("desk.rail on an empty workspace shows the setup steps and nothing else", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  expect(
    await caller.desk.rail({ dayStart: DAY_START, scope: "mine" })
  ).toEqual({
    counts: { everyone: 0, mine: 0 },
    doneToday: 0,
    needsYou: [],
    setup: ["ai_account", "first_agent"],
    working: [],
  });
});

test("desk.clearAttention rejects an unknown run with NOT_FOUND", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  await expect(
    caller.desk.clearAttention({ runId: "run_missing" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("members.list returns the lister's members sorted by name", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });

  expect(await caller.members.list()).toEqual([
    { name: "Ann Adler", userId: "user_1" },
    { name: "Zoe Berg", userId: "user_2" },
  ]);
  expect(listedOrgs).toEqual(["org_a"]);
});

test("members.list without a lister in infra gets BAD_REQUEST", async () => {
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    servicesFor(false)
  );

  await expect(caller.members.list()).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("agents.setOwners sets the owner and backup, read back through agents.get", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(AGENT);

  const updated = await caller.agents.setOwners({
    backupUserId: "user_2",
    id: agent.id,
    ownerUserId: "user_1",
  });

  expect(updated).toMatchObject({
    backupUserId: "user_2",
    ownerUserId: "user_1",
  });
  expect(await caller.agents.get({ id: agent.id })).toMatchObject({
    backupUserId: "user_2",
    ownerUserId: "user_1",
  });
});

test("agents.setOwners refuses a backup equal to the owner with BAD_REQUEST", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(AGENT);

  await expect(
    caller.agents.setOwners({
      backupUserId: "user_2",
      id: agent.id,
      ownerUserId: "user_2",
    })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("agents.setOwners refuses a user the lister does not return with BAD_REQUEST", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(AGENT);

  await expect(
    caller.agents.setOwners({
      backupUserId: null,
      id: agent.id,
      ownerUserId: "user_outsider",
    })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("agents.overview returns one row per agent with zero counts when idle", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(AGENT);

  expect(await caller.agents.overview()).toEqual([
    {
      agentId: agent.id,
      costUsdThisWeek: null,
      tasksThisWeek: 0,
      waiting: 0,
      working: 0,
    },
  ]);
});
