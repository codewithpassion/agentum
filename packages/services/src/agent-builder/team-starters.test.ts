import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { events } from "@repo/db/schema/events";
import { agentLibraryAccess, libraryEntries } from "@repo/db/schema/library";
import { teamMembers, teams } from "@repo/db/schema/teams";
import { agentToolRules } from "@repo/db/schema/tool-rules";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { ForbiddenError } from "../authz.ts";
import { askKeysOf } from "../requests/ask-keys.ts";
import type { Principal } from "../workspaces.ts";
import type { BuilderCatalog } from "./draft.ts";
import { createTeamStarterLifecycle } from "./team-starters.ts";

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "w1",
};
const catalog: BuilderCatalog = {
  agents: [],
  connectors: [],
  machines: [],
  runtimes: ["cloud", "managed"],
  skills: [],
};
let db: ReturnType<typeof migrated>;
let calls: number;
let builder: ReturnType<typeof createTeamStarterLifecycle>;
beforeEach(() => {
  db = migrated();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org1",
      createdAt: "2026-11-20T00:00:00Z",
      id: "w1",
      name: "Test",
      timezone: "UTC",
    })
    .run();
  calls = 0;
  builder = createTeamStarterLifecycle({
    atomic: async (statements) => {
      calls += 1;
      await sqliteAtomic(db)(statements);
    },
    catalog: async () => catalog,
    clock: {
      now: () => new Date("2026-11-20T00:00:00Z"),
      sleep: async () => undefined,
    },
    db,
  });
});

const expectEmpty = () => {
  for (const table of [
    agents,
    teams,
    teamMembers,
    agentToolRules,
    events,
    libraryEntries,
    agentLibraryAccess,
  ]) {
    // biome-ignore lint/suspicious/noMisplacedAssertion: Shared assertion called inside each test.
    expect(db.select().from(table).all()).toEqual([]);
  }
  // biome-ignore lint/suspicious/noMisplacedAssertion: Shared assertion called inside each test.
  expect(calls).toBe(0);
};

for (const key of ["sales", "back_office"] as const) {
  test(`${key}: review is read only; confirmation creates four agents and a lead in one atomic call`, async () => {
    const review = await builder.teamFromStarter(user, key);
    expect(review.draft.name).toBe(key === "sales" ? "Sales" : "Back office");
    expect(review.draft.members.map((member) => member.name)).toEqual(
      key === "sales"
        ? ["Sales lead", "Lead research", "Outreach drafts", "CRM tidy"]
        : [
            "Back office lead",
            "Invoice filing",
            "Shared drive tidy",
            "Weekly report",
          ]
    );
    expect(review.draft.rules).toContain("No member edits its own skill");
    expect(review.members).toHaveLength(4);
    expectEmpty();
    for (const member of review.draft.members) {
      member.runsOn = { runtime: "cloud" };
    }
    review.draft.name += " reviewed";
    // Review edits cannot accidentally remove the starter protection.
    review.draft.rules = "Reviewed team rules";
    review.draft.members[3].rules = [];
    const team = await builder.createTeam(user, { draft: review.draft });
    expect(calls).toBe(1);
    expect(team.name).toEndWith(" reviewed");
    expect(team.members).toHaveLength(4);
    expect(team.members.every((member) => member.isHome)).toBe(true);
    expect(team.members.map((member) => member.memberId)).toContain(
      team.leadAgentId ?? ""
    );
    const rows = db.select().from(agents).all();
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.id === team.leadAgentId)?.name).toBe(
      review.draft.members[0].name
    );
    const askKeys = await Promise.all(rows.map((row) => askKeysOf(db, row)));
    expect(
      askKeys.every((keys) => keys.includes("harbourmaster/commit_skill"))
    ).toBe(true);
    expect(
      rows.every((row) => row.status === "active" && row.createdBy === "u1")
    ).toBe(true);
    expect(
      rows.every((row) =>
        row.instructions.includes("No member edits its own skill")
      )
    ).toBe(true);
    expect(
      db
        .select()
        .from(agentToolRules)
        .all()
        .map((rule) => [rule.toolKey, rule.mode])
    ).toEqual(
      Array.from({ length: 4 }, () => ["harbourmaster/commit_skill", "ask"])
    );
    expect(db.select().from(events).all()).toHaveLength(4);
    expect(db.select().from(agentLibraryAccess).all()).toHaveLength(4);
    expect(db.select().from(libraryEntries).all()).toHaveLength(2);
  });

  test(`${key}: an invalid last member creates nothing`, async () => {
    const { draft } = await builder.teamFromStarter(user, key);
    for (const member of draft.members) {
      member.runsOn = { runtime: "cloud" };
    }
    draft.members[3].name = "x".repeat(81);
    await expect(builder.createTeam(user, { draft })).rejects.toThrow();
    expectEmpty();
  });
}

test("unresolved runtime and stale choices reject before writing", async () => {
  const { draft } = await builder.teamFromStarter(user, "sales");
  await expect(builder.createTeam(user, { draft })).rejects.toThrow();
  for (const member of draft.members) {
    member.runsOn = { runtime: "cloud" };
  }
  draft.members[3].tools = ["missing"];
  await expect(builder.createTeam(user, { draft })).rejects.toThrow();
  expectEmpty();
});

test("a database failure rolls back agents as well as the team", async () => {
  const { draft } = await builder.teamFromStarter(user, "sales");
  for (const member of draft.members) {
    member.runsOn = { runtime: "cloud" };
  }
  db.insert(teams)
    .values({
      createdAt: "2026-11-20T00:00:00Z",
      id: "existing",
      name: "Sales",
      slug: "sales",
      workspaceId: "w1",
    })
    .run();
  await expect(builder.createTeam(user, { draft })).rejects.toMatchObject({
    code: "conflict",
    message: "Team slug is already used",
  });
  expect(db.select().from(agents).all()).toEqual([]);
  expect(db.select().from(teams).all()).toHaveLength(1);
});

test("a taken agent slug is a conflict and creates nothing", async () => {
  const { draft } = await builder.teamFromStarter(user, "sales");
  for (const member of draft.members) {
    member.runsOn = { runtime: "cloud" };
  }
  db.insert(agents)
    .values({
      createdAt: "2026-11-20T00:00:00Z",
      createdBy: "u1",
      id: "existing",
      instructions: "",
      model: "m",
      name: "Lead research",
      runtime: "cloud",
      runtimeConfig: "{}",
      slug: "lead-research",
      status: "active",
      workspaceId: "w1",
    })
    .run();
  await expect(builder.createTeam(user, { draft })).rejects.toMatchObject({
    code: "conflict",
  });
  expect(db.select().from(agents).all()).toHaveLength(1);
  expect(db.select().from(teams).all()).toEqual([]);
});

test("two members with the same name are a conflict", async () => {
  const { draft } = await builder.teamFromStarter(user, "sales");
  for (const member of draft.members) {
    member.runsOn = { runtime: "cloud" };
  }
  draft.members[3].name = draft.members[2].name;
  await expect(builder.createTeam(user, { draft })).rejects.toMatchObject({
    code: "conflict",
  });
  expectEmpty();
});

test("unknown starters and non-user or read-only callers are refused", async () => {
  await expect(builder.teamFromStarter(user, "missing")).rejects.toThrow();
  const { draft } = await builder.teamFromStarter(user, "sales");
  for (const principal of [
    { kind: "system" },
    { ...user, apiKey: { access: "read", id: "key" }, via: "api_key" },
  ] as Principal[]) {
    // biome-ignore lint/performance/noAwaitInLoops: Check each refused principal independently.
    await expect(
      builder.createTeam(principal, { draft })
    ).rejects.toBeInstanceOf(ForbiddenError);
  }
  expectEmpty();
});
