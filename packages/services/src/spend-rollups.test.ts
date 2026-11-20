import { afterEach, beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { dreamRuns } from "@repo/db/schema/dreams";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { teams } from "@repo/db/schema/teams";
import { workspaces } from "@repo/db/schema/workspaces";
import { sumSpendCents } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "./authz.ts";
import { createSpendService } from "./spend.ts";
import {
  dayInTimezone,
  mondayWeekStart,
  rollupSpend,
} from "./spend-rollups.ts";
import { costOf } from "./usage-cost.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "./workspaces.ts";

const user: Principal = {
  kind: "user",
  userId: "u",
  via: "session",
  workspaceId: "w",
};
const range = { from: "2026-11-16", to: "2026-11-17" };
const now = new Date("2026-11-17T02:00:00.000Z");
const monday = "2026-11-15T13:00:00.000Z";
const sunday = "2026-11-15T12:59:59.999Z";
let db: ReturnType<typeof migrated>;
let spend: ReturnType<typeof createSpendService>;
beforeEach(() => {
  db = migrated();
  for (const id of ["w", "other"]) {
    db.insert(workspaces)
      .values({
        clerkOrgId: id,
        createdAt: monday,
        id,
        name: id,
        timezone: "Australia/Sydney",
      })
      .run();
  }
  for (const [id, workspaceId] of [
    ["a", "w"],
    ["b", "w"],
    ["empty", "w"],
    ["foreign", "other"],
  ] as const) {
    db.insert(agents)
      .values({
        createdAt: monday,
        createdBy: "u",
        id,
        instructions: "",
        model: "test",
        name: id,
        runtime: "cloud",
        runtimeConfig: "{}",
        slug: id,
        status: "active",
        workspaceId,
      })
      .run();
    db.insert(sessions)
      .values({
        actorId: "u",
        actorKind: "user",
        agentId: id,
        createdAt: monday,
        id,
        origin: "ui",
        workspaceId,
      })
      .run();
  }
  db.insert(teams)
    .values({
      createdAt: monday,
      id: "team-a",
      name: "Team A",
      slug: "team-a",
      workspaceId: "w",
    })
    .run();
  spend = createSpendService({
    atomic: sqliteAtomic(db),
    clock: { now: () => now, sleep: () => Promise.resolve() },
    db,
  });
});
afterEach(() => db.client.close());
const run = async (
  id: string,
  agentId: string,
  createdAt: string,
  usage: string | null,
  dryRun = false
) => {
  await db.insert(runs).values({
    actorId: "u",
    actorKind: "user",
    agentId,
    createdAt,
    dryRun,
    finishedAt: "2026-11-20T00:00:00.000Z",
    id,
    inputText: "",
    sessionId: agentId,
    status: "done",
    usage,
    workspaceId: agentId === "foreign" ? "other" : "w",
  });
};
const dream = async (
  id: string,
  agentId: string,
  startedAt: string,
  costUsd: number
) => {
  await db.insert(dreamRuns).values({
    agentId,
    id,
    startedAt,
    status: "done",
    usage: JSON.stringify({ costUsd }),
    workspaceId: agentId === "foreign" ? "other" : "w",
  });
};
test("pure cost reader preserves missing and malformed usage behavior", () => {
  for (const raw of [
    null,
    "bad",
    "null",
    "[]",
    "{}",
    '{"costUsd":"1"}',
    '{"costUsd":1e400}',
  ]) {
    expect(costOf(raw)).toBe(0);
  }
  expect(costOf('{"costUsd":0.004}')).toBe(0.004);
  expect(costOf('{"costUsd":-1}')).toBe(-1);
});
const teamDream = async (
  id: string,
  teamId: string,
  startedAt: string,
  costUsd: number
) => {
  await db.insert(dreamRuns).values({
    agentId: null,
    id,
    startedAt,
    status: "done",
    teamId,
    usage: JSON.stringify({ costUsd }),
    workspaceId: "w",
  });
};
test("pure timezone bucketing and Monday start follow local calendar across DST", () => {
  expect(dayInTimezone(monday, "Australia/Sydney")).toBe("2026-11-16");
  expect(mondayWeekStart(new Date(monday), "Australia/Sydney")).toBe(
    "2026-11-16"
  );
  expect(mondayWeekStart(new Date(sunday), "Australia/Sydney")).toBe(
    "2026-11-09"
  );
  expect(
    mondayWeekStart(new Date("2026-11-01T08:30:00.000Z"), "America/New_York")
  ).toBe("2026-10-26");
  expect(
    mondayWeekStart(new Date("2026-11-16T10:00:00.000Z"), "Pacific/Honolulu")
  ).toBe("2026-11-16");
});
test("daily rollups sum before rounding, include dreams and unpriced tasks, exclude dry runs and other workspaces", async () => {
  await run("outside", "a", sunday, '{"costUsd":99}');
  await run("first", "a", monday, '{"costUsd":0.004}');
  await run("second", "a", "2026-11-16T12:59:59.999Z", '{"costUsd":0.004}');
  await run("null", "a", monday, null);
  await run("missing", "a", monday, "{}");
  await run("dry", "a", monday, '{"costUsd":99}', true);
  await dream("extra", "a", monday, 0.008);
  await dream("only", "b", "2026-11-16T13:00:00.000Z", 0.25);
  await run("next", "a", "2026-11-17T13:00:00.000Z", '{"costUsd":99}');
  await run("foreign", "foreign", monday, '{"costUsd":99}');
  await dream("foreign", "foreign", monday, 99);
  expect(await spend.workspace(user, range)).toEqual([
    { agentId: "a", cents: 2, day: "2026-11-16", micros: 16_000, tasks: 4 },
    { agentId: "b", cents: 25, day: "2026-11-17", micros: 250_000, tasks: 0 },
  ]);
  expect(await spend.byAgent(user, "a", range)).toEqual([
    { agentId: "a", cents: 2, day: "2026-11-16", micros: 16_000, tasks: 4 },
  ]);
  expect(
    await Promise.all(
      ["foreign", "empty", "unknown"].map((id) =>
        spend.byAgent(user, id, range)
      )
    )
  ).toEqual([[], [], []]);
});
test("unpriced rows sort by day then agent, with an empty dream table", async () => {
  await run("b", "b", monday, null);
  await run("a", "a", monday, "bad");
  expect(await spend.workspace(user, range)).toEqual([
    { agentId: "a", cents: 0, day: "2026-11-16", micros: 0, tasks: 1 },
    { agentId: "b", cents: 0, day: "2026-11-16", micros: 0, tasks: 1 },
  ]);
});
test("week to date includes Monday and dreams through now, excluding Sunday, dry runs and future", async () => {
  await Promise.all(
    (
      [
        ["sun", sunday, 99],
        ["mon", monday, 0.004],
        ["now", now.toISOString(), 0.004],
        ["future", "2026-11-17T02:00:00.001Z", 99],
      ] as const
    ).map(([id, at, cost]) =>
      Promise.all([
        run(id, "a", at, JSON.stringify({ costUsd: cost })),
        dream(id, "a", at, cost),
      ])
    )
  );
  await run("dry", "a", monday, '{"costUsd":99}', true);
  expect(await spend.weekToDate("a")).toBe(2);
  expect(await spend.weekToDate("empty")).toBe(0);
});
test("agent and workspace caps trip at equality, including dreams; null caps never trip", async () => {
  await run("a", "a", monday, '{"costUsd":0.4}');
  await dream("a", "a", monday, 0.1);
  await dream("b", "b", monday, 0.5);
  await dream("foreign", "foreign", monday, 99);
  expect(await spend.wouldExceed("a")).toBe(false);
  await db.update(agents).set({ weeklyCapCents: 51 }).where(eq(agents.id, "a"));
  expect(await spend.wouldExceed("a")).toBe(false);
  await db.update(agents).set({ weeklyCapCents: 50 }).where(eq(agents.id, "a"));
  expect(await spend.wouldExceed("a")).toBe(true);
  await db
    .update(agents)
    .set({ weeklyCapCents: null })
    .where(eq(agents.id, "a"));
  await db
    .update(workspaces)
    .set({ weeklyCapCents: 101 })
    .where(eq(workspaces.id, "w"));
  expect(await spend.wouldExceed("a")).toBe(false);
  await db
    .update(workspaces)
    .set({ weeklyCapCents: 100 })
    .where(eq(workspaces.id, "w"));
  expect(await spend.wouldExceed("a")).toBe(true);
  expect(await spend.wouldExceed("empty")).toBe(true);
});
test("unknown internal agents throw not_found and system reads remain refused", async () => {
  await expect(spend.weekToDate("unknown")).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(spend.wouldExceed("unknown")).rejects.toMatchObject({
    code: "not_found",
  });
  expect(() => spend.workspace(SYSTEM_PRINCIPAL, range)).toThrow(
    ForbiddenError
  );
  expect(() => spend.byAgent(SYSTEM_PRINCIPAL, "a", range)).toThrow(
    ForbiddenError
  );
});

test("a team row has no agent, keeps its teamId, and sorts by team id among agents", () => {
  const rows = rollupSpend(
    [
      { agentId: "b", at: monday, costUsd: 0.1, tasks: 1 },
      { agentId: null, at: monday, costUsd: 0.2, tasks: 0, teamId: "a" },
      { agentId: null, at: monday, costUsd: 0.2, tasks: 0, teamId: "a" },
      { agentId: null, at: monday, costUsd: 0.3, tasks: 0, teamId: "c" },
    ],
    "Australia/Sydney",
    range
  );
  expect(rows).toEqual([
    {
      agentId: null,
      cents: 40,
      day: "2026-11-16",
      micros: 400_000,
      tasks: 0,
      teamId: "a",
    },
    { agentId: "b", cents: 10, day: "2026-11-16", micros: 100_000, tasks: 1 },
    {
      agentId: null,
      cents: 30,
      day: "2026-11-16",
      micros: 300_000,
      tasks: 0,
      teamId: "c",
    },
  ]);
  expect(rows.map((row) => "teamId" in row)).toEqual([true, false, true]);
});

test("a team dream is its own workspace row and counts toward no agent", async () => {
  await teamDream("td", "team-a", monday, 0.25);
  expect(await spend.workspace(user, range)).toEqual([
    {
      agentId: null,
      cents: 25,
      day: "2026-11-16",
      micros: 250_000,
      tasks: 0,
      teamId: "team-a",
    },
  ]);
  expect(await spend.byAgent(user, "a", range)).toEqual([]);
  await teamDream("td-future", "team-a", "2026-11-17T02:00:00.001Z", 99);
  expect(await spend.weekToDate("a")).toBe(0);
});

test("a week of small days is rounded once, not once per day", () => {
  const facts = ["2026-11-16", "2026-11-17", "2026-11-18"].map((day) => ({
    agentId: "a",
    at: `${day}T02:00:00.000Z`,
    costUsd: 0.004,
    tasks: 1,
  }));
  const rows = rollupSpend(facts, "UTC", {
    from: "2026-11-16",
    to: "2026-11-18",
  });
  expect(rows.map((row) => row.cents)).toEqual([0, 0, 0]);
  expect(rows.map((row) => row.micros)).toEqual([4000, 4000, 4000]);
  expect(sumSpendCents(rows)).toBe(1);
});
