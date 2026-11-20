import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents } from "./schema/agents.ts";
import { workspaces } from "./schema/workspaces.ts";
import {
  NEEDS_YOU_HEADINGS,
  NEEDS_YOU_KINDS,
  SPEND_PAUSE_REASONS,
} from "./shared.ts";
import { migrated } from "./test-db.ts";

const NOW = "2026-01-01T00:00:00.000Z";

interface Column {
  dflt_value: string | null;
  name: string;
  notnull: number;
}

const agent = (id: string) => ({
  createdAt: NOW,
  createdBy: "u1",
  id,
  instructions: "",
  model: "m",
  name: id,
  runtime: "fake" as const,
  runtimeConfig: "{}",
  slug: id,
  status: "active",
  workspaceId: "w1",
});

test("agents and workspaces gain the spend columns, nullable with no default", () => {
  const { client } = migrated();
  const columns = (table: string) =>
    client.query<Column, []>(`PRAGMA table_info(${table})`).all();
  const wanted: Record<string, string[]> = {
    agents: ["paused_at", "paused_reason", "weekly_cap_cents"],
    workspaces: ["weekly_cap_cents"],
  };
  for (const [table, names] of Object.entries(wanted)) {
    for (const name of names) {
      const column = columns(table).find((c) => c.name === name);
      expect(column?.notnull, `${table}.${name}`).toBe(0);
      expect(column?.dflt_value, `${table}.${name}`).toBeNull();
    }
  }
});

test("the spend pause reasons are the documented set", () => {
  expect([...SPEND_PAUSE_REASONS]).toEqual(["spend_cap", "manual"]);
});

test("the Needs you kinds include spend_pause with a heading that names the agent", () => {
  expect(NEEDS_YOU_KINDS).toContain("spend_pause");
  expect(NEEDS_YOU_HEADINGS.spend_pause("Ada")).toContain("Ada");
});

test("a paused agent with a weekly cap reads back its pause and cap", () => {
  const db = migrated();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: NOW,
      id: "w1",
      name: "w1",
      timezone: "UTC",
    })
    .run();
  db.insert(agents)
    .values({
      ...agent("a1"),
      pausedAt: "2026-01-01T00:00:00.000Z",
      pausedReason: "spend_cap",
      weeklyCapCents: 5000,
    })
    .run();

  const [row] = db.select().from(agents).where(eq(agents.id, "a1")).all();
  expect(row?.pausedAt).toBe("2026-01-01T00:00:00.000Z");
  expect(row?.pausedReason).toBe("spend_cap");
  expect(row?.weeklyCapCents).toBe(5000);
});

test("a workspace weekly cap is null on a fresh row and reads back after an update", () => {
  const db = migrated();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: NOW,
      id: "w1",
      name: "w1",
      timezone: "UTC",
    })
    .run();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w2",
      createdAt: NOW,
      id: "w2",
      name: "w2",
      timezone: "UTC",
    })
    .run();

  const [fresh] = db
    .select({ weeklyCapCents: workspaces.weeklyCapCents })
    .from(workspaces)
    .where(eq(workspaces.id, "w2"))
    .all();
  expect(fresh?.weeklyCapCents).toBeNull();

  db.update(workspaces)
    .set({ weeklyCapCents: 20_000 })
    .where(eq(workspaces.id, "w1"))
    .run();
  const [updated] = db
    .select({ weeklyCapCents: workspaces.weeklyCapCents })
    .from(workspaces)
    .where(eq(workspaces.id, "w1"))
    .all();
  expect(updated?.weeklyCapCents).toBe(20_000);
});
