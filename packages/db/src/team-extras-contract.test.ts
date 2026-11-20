import { expect, test } from "bun:test";
import { agents } from "./schema/agents.ts";
import { workspaces } from "./schema/workspaces.ts";
import {
  DISCUSSION_ROUNDS_MAX,
  DISCUSSION_STATUSES,
  NEEDS_YOU_HEADINGS,
  NEEDS_YOU_KINDS,
  REQUEST_KINDS,
} from "./shared.ts";
import { migrated } from "./test-db.ts";

const NOW = "2026-01-01T00:00:00.000Z";

interface Column {
  name: string;
  notnull: number;
}

const DISCUSSION_COLUMNS = [
  "created_at",
  "id",
  "round",
  "rounds",
  "started_by_agent_id",
  "status",
  "thread_id",
  "workspace_id",
];

const columnsOf = (
  client: ReturnType<typeof migrated>["client"],
  table: string
) => client.query<Column, []>(`PRAGMA table_info(${table})`).all();

test("decisions is a request kind and a Needs you kind with a heading", () => {
  expect(REQUEST_KINDS).toContain("decisions");
  expect(NEEDS_YOU_KINDS).toContain("decisions");
  expect(NEEDS_YOU_HEADINGS.decisions("Ada")).toContain("Ada");
});

test("memory_changes and dream_runs have a nullable team_id and a nullable agent_id", () => {
  const { client } = migrated();
  for (const table of ["memory_changes", "dream_runs"]) {
    const columns = columnsOf(client, table);
    for (const name of ["agent_id", "team_id"]) {
      expect(
        columns.find((c) => c.name === name)?.notnull,
        `${table}.${name}`
      ).toBe(0);
    }
  }
});

test("discussions has exactly the documented columns, all NOT NULL", () => {
  const { client } = migrated();
  const columns = columnsOf(client, "discussions");
  expect(columns.map((c) => c.name).sort()).toEqual(DISCUSSION_COLUMNS);
  for (const column of columns) {
    expect(column.notnull, column.name).toBe(1);
  }
  expect(DISCUSSION_STATUSES).toEqual(["running", "done", "stopped"]);
  expect(DISCUSSION_ROUNDS_MAX).toBe(5);
});

test("a discussion row needs an existing topic and lead", async () => {
  const db = migrated();
  await db.insert(workspaces).values({
    clerkOrgId: "org_w1",
    createdAt: NOW,
    id: "w1",
    name: "w1",
    timezone: "UTC",
  });
  await db.insert(agents).values({
    createdAt: NOW,
    createdBy: "u1",
    id: "a1",
    instructions: "",
    model: "m",
    name: "a1",
    runtime: "fake",
    runtimeConfig: "{}",
    slug: "a1",
    status: "active",
    workspaceId: "w1",
  });
  expect(() =>
    db.client.run(
      "INSERT INTO discussions (id, workspace_id, thread_id, started_by_agent_id, rounds, round, status, created_at) VALUES ('d1', 'w1', 'nope', 'a1', 3, 1, 'running', ?)",
      [NOW]
    )
  ).toThrow();
  db.client.run(
    "INSERT INTO inbox_threads (id, workspace_id, created_at, created_by, last_post_at, title) VALUES ('t1', 'w1', ?, 'u1', ?, 'Topic')",
    [NOW, NOW]
  );
  db.client.run(
    "INSERT INTO discussions (id, workspace_id, thread_id, started_by_agent_id, rounds, round, status, created_at) VALUES ('d1', 'w1', 't1', 'a1', 3, 1, 'running', ?)",
    [NOW]
  );
  expect(
    db.client.query("SELECT round, rounds, status FROM discussions").all()
  ).toEqual([{ round: 1, rounds: 3, status: "running" }]);
});
