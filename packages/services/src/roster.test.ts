import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { machines } from "@repo/db/schema/machines";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { triggers } from "@repo/db/schema/triggers";
import type { RailView } from "@repo/db/shared";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { createAgentsService } from "./agents.ts";
import { createEventsService } from "./events.ts";
import { agents } from "@repo/db/schema/agents";
import { workspaces } from "@repo/db/schema/workspaces";
import { defaultAgentAvatar } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { ForbiddenError } from "./authz.ts";
import { createRosterService } from "./roster.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const NOW = "2026-01-01T00:00:00.000Z";
const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const system: Principal = { kind: "system" };

let db: ReturnType<typeof migrated>;
let railView: RailView;
let queries: number;
const clock = { now: () => new Date(NOW), sleep: () => Promise.resolve() };
let service: ReturnType<typeof createRosterService>;

const seedWorkspace = (conn: ReturnType<typeof migrated>, id: string) =>
  conn
    .insert(workspaces)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: NOW,
      id,
      name: id,
      timezone: "UTC",
    })
    .run();

const insertAgent = (
  row: { id: string; name: string } & Partial<typeof agents.$inferInsert>
) =>
  db
    .insert(agents)
    .values({
      createdAt: NOW,
      createdBy: "u1",
      emailLocal: null,
      handsTo: "[]",
      instructions: "",
      machineId: null,
      model: "m",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: row.id,
      soul: "",
      status: "active",
      workspaceId: WORKSPACE,
      ...row,
    })
    .run();

beforeEach(() => {
  const migratedDb = migrated();
  queries = 0;
  db = Object.assign(drizzle(migratedDb.client, { logger: { logQuery: () => { queries += 1; } } }), { client: migratedDb.client });
  seedWorkspace(db, WORKSPACE);
  seedWorkspace(db, OTHER_WORKSPACE);
  railView = { needsYou: [], working: [], doneToday: 0, counts: { mine: 0, everyone: 0 }, setup: [] };
  service = createRosterService({ db, clock, rail: { get: () => Promise.resolve(railView) } });
});

test("lists active agents only, ordered by name, each as an idle card", async () => {
  insertAgent({
    avatar: '{"color":"blue","glyph":"Z"}',
    id: "a-zeta",
    name: "Zeta",
    instructions: "  \n  Line one.  \nLine two",
    soul: "Ignored soul",
  });
  insertAgent({ id: "a-alpha", name: "Alpha", instructions: "x".repeat(200) });
  insertAgent({ id: "a-old", name: "Old", status: "archived" });
  insertAgent({ id: "a-draft", name: "Drafted", status: "draft" });

  expect(await service.list(user)).toEqual([
    {
      avatar: { color: "slate", glyph: "?" },
      costThisWeekCents: 0,
      id: "a-alpha",
      isLead: false,
      jobLine: "x".repeat(80),
      learnedCount: 0,
      name: "Alpha",
      needsYouCount: 0,
      ownerName: "",
      slug: "a-alpha",
      state: "idle",
      statusLine: "Idle",
      teamId: null,
      weeklyCapCents: null,
    },
    {
      avatar: { color: "blue", glyph: "Z" },
      costThisWeekCents: 0,
      id: "a-zeta",
      isLead: false,
      jobLine: "Line one.",
      learnedCount: 0,
      name: "Zeta",
      needsYouCount: 0,
      ownerName: "",
      slug: "a-zeta",
      state: "idle",
      statusLine: "Idle",
      teamId: null,
      weeklyCapCents: null,
    },
  ]);
});

test("an avatar column that is not JSON, or does not validate, falls back to the default avatar", async () => {
  insertAgent({ avatar: "not json", id: "a-bad-json", name: "Bree" });
  insertAgent({
    avatar: '{"color":"pink","glyph":"B"}',
    id: "a-bad-color",
    name: "Cass",
  });

  const cards = await service.list(user);
  expect(cards.map((card) => card.avatar)).toEqual([
    defaultAgentAvatar("Bree"),
    defaultAgentAvatar("Cass"),
  ]);
});

test("a valid avatar column comes back unchanged", async () => {
  insertAgent({
    avatar: '{"color":"teal","glyph":"★"}',
    id: "a-good",
    name: "Dana",
  });

  const [card] = await service.list(user);
  expect(card?.avatar).toEqual({ color: "teal", glyph: "★" });
});

test("another workspace's agents are not listed", async () => {
  insertAgent({ id: "a-mine", name: "Mine" });
  insertAgent({
    id: "a-theirs",
    name: "Theirs",
    workspaceId: OTHER_WORKSPACE,
  });

  expect((await service.list(user)).map((card) => card.id)).toEqual(["a-mine"]);
});

test("the system principal is refused", async () => {
  await expect(service.list(system)).rejects.toBeInstanceOf(ForbiddenError);
});

const seedRun = (id: string, values: Partial<typeof runs.$inferInsert> = {}, sessionValues: Partial<typeof sessions.$inferInsert> = {}) => {
  db.insert(sessions).values({ id: `s-${id}`, agentId: "a1", actorId: "u1", actorKind: "user", origin: "slack", createdAt: NOW, workspaceId: WORKSPACE, ...sessionValues }).run();
  db.insert(runs).values({ id, agentId: "a1", actorId: "u1", actorKind: "user", inputText: "Prepare the report", status: "running", createdAt: NOW, sessionId: `s-${id}`, workspaceId: WORKSPACE, ...values }).run();
};

test("a running run supplies its task title", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1");
  expect((await service.list(user))[0]).toMatchObject({ state: "working", statusLine: "Prepare the report" });
});

test.each(["failed", "interrupted"] as const)("a %s last run is stopped, ahead of a running run", async (status) => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1", { createdAt: "2025-12-31T23:00:00.000Z" });
  seedRun("r2", { status });
  expect((await service.list(user))[0]?.state).toBe("stopped");
});

test("an older failure does not stop a newer successful run", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1", { status: "failed", createdAt: "2025-12-31T23:00:00.000Z" });
  seedRun("r2", { status: "done" });
  expect((await service.list(user))[0]?.state).toBe("idle");
});

test("an archived machine stops an agent even with a running run", async () => {
  db.insert(machines).values({ id: "m1", name: "Mac", workspaceId: WORKSPACE, createdAt: NOW, capabilities: "{}", credentialHash: "hash", enrolledBy: "u1", singleUser: false, status: "archived" }).run();
  insertAgent({ id: "a1", name: "Alpha", machineId: "m1" });
  seedRun("r1");
  expect((await service.list(user))[0]?.state).toBe("stopped");
});

test("Needs you beats stopped and working; problems remain stopped", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1", { status: "failed" });
  const card = { id: "q1", agentId: "a1", agentName: "Alpha", at: NOW, kind: "question" as const, title: "Which report?", detail: "", expiresAt: null, mail: null, passedOnBy: null, runId: "r1", status: "Waiting", threadId: null };
  railView.needsYou = [{ id: "q1", assigneeName: "Ann", assigneeUserId: "u1", cards: [card], dueAt: null, escalatedToMe: false, mine: true }];
  expect((await service.list(user))[0]).toMatchObject({ state: "needs_you", statusLine: "Which report?", needsYouCount: 1, ownerName: "Ann" });
  railView.needsYou[0]!.cards = [{ ...card, kind: "problem" }];
  expect((await service.list(user))[0]).toMatchObject({ state: "stopped", needsYouCount: 0 });
});

test("idle uses the earliest enabled routine in the workspace timezone", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  db.update(workspaces).set({ timezone: "Australia/Sydney" }).where(eq(workspaces.id, WORKSPACE)).run();
  for (const [id, cron, disabledAt, revokedAt] of [["late", "0 15 * * *", null, null], ["next", "0 12 * * *", null, null], ["disabled", "1 11 * * *", NOW, null], ["revoked", "2 11 * * *", null, NOW]] as const) {
    db.insert(triggers).values({ id, agentId: "a1", name: id, kind: "routine", cron, createdAt: NOW, createdBy: "u1", workspaceId: WORKSPACE, timezone: "UTC", disabledAt, revokedAt }).run();
  }
  expect((await service.list(user))[0]?.statusLine).toBe("Idle. Next run 1 Jan, 12:00 pm");
});

test("cost sums the last seven days, rounds once to cents, excludes dry and hidden runs", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("one", { usage: '{"costUsd":0.124}' });
  seedRun("two", { usage: '{"costUsd":0.124}', status: "done", createdAt: "2025-12-25T00:00:00.000Z" });
  seedRun("old", { usage: '{"costUsd":100}', createdAt: "2025-12-24T23:59:59.999Z" });
  seedRun("dry", { usage: '{"costUsd":100}', dryRun: true });
  seedRun("hidden", { usage: '{"costUsd":100}' }, { private: true, actorId: "u2" });
  seedRun("missing", { usage: '{}' });
  expect((await service.list(user))[0]?.costThisWeekCents).toBe(25);
});

test("a member sees exactly the same agents as agents.list", async () => {
  insertAgent({ id: "mine", name: "Mine" });
  insertAgent({ id: "other-owner", name: "Other", ownerUserId: "u2" });
  insertAgent({ id: "archived", name: "Archived", status: "archived" });
  insertAgent({ id: "draft", name: "Draft", status: "draft" });
  insertAgent({ id: "foreign", name: "Foreign", workspaceId: OTHER_WORKSPACE });
  const events = createEventsService({ db, blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() } });
  const agentService = createAgentsService({ db, atomic: sqliteAtomic(db), events });
  expect((await service.list(user)).map((card) => card.id)).toEqual((await agentService.list(user)).map((agent) => agent.id));
});

test("50 agents use a constant number of database queries", async () => {
  for (let index = 0; index < 50; index += 1) {
    insertAgent({ id: `a${index}`, name: `Agent ${index}` });
    seedRun(`r${index}`, { agentId: `a${index}` }, { agentId: `a${index}` });
  }
  queries = 0;
  expect(await service.list(user)).toHaveLength(50);
  expect(queries).toBeLessThanOrEqual(8);
});
