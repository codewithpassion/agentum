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

test("memory_changes, dream_runs and dream_questions have a nullable team_id and a nullable agent_id", () => {
  const { client } = migrated();
  for (const table of ["memory_changes", "dream_runs", "dream_questions"]) {
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

test("a memory change, dream run or dream question has an agent or a team, never both or neither", async () => {
  const db = migrated();
  await db.insert(workspaces).values({
    clerkOrgId: "org_w1",
    createdAt: NOW,
    id: "w1",
    name: "w1",
    timezone: "UTC",
  });
  db.client.run(
    "INSERT INTO agents (created_at, created_by, id, instructions, model, name, runtime, runtime_config, slug, status, workspace_id) VALUES (?, 'u1', 'a1', '', 'm', 'a1', 'fake', '{}', 'a1', 'active', 'w1')",
    [NOW]
  );
  db.client.run(
    "INSERT INTO teams (created_at, id, name, rules, slug, workspace_id) VALUES (?, 't1', 't1', '', 't1', 'w1')",
    [NOW]
  );
  const run = (agent: string | null, team: string | null) =>
    db.client.run(
      "INSERT INTO dream_runs (id, workspace_id, agent_id, team_id, started_at, status) VALUES (?, 'w1', ?, ?, ?, 'running')",
      [`d-${agent}-${team}`, agent, team, NOW]
    );
  run("a1", null);
  run(null, "t1");
  expect(() => run("a1", "t1")).toThrow();
  expect(() => run(null, null)).toThrow();

  const change = (agent: string | null, team: string | null) =>
    db.client.run(
      "INSERT INTO memory_changes (id, workspace_id, agent_id, team_id, action, created_at, kind, note_id, status, text, written_by) VALUES (?, 'w1', ?, ?, 'add', ?, 'work', 'n', 'applied', 't', 'dream')",
      [`c-${agent}-${team}`, agent, team, NOW]
    );
  change("a1", null);
  change(null, "t1");
  expect(() => change("a1", "t1")).toThrow();
  expect(() => change(null, null)).toThrow();

  const question = (agent: string | null, team: string | null) =>
    db.client.run(
      "INSERT INTO dream_questions (id, workspace_id, agent_id, team_id, dream_run_id, created_at, options, question, status) VALUES (?, 'w1', ?, ?, 'd-null-t1', ?, '[]', 'Which?', 'open')",
      [`q-${agent}-${team}`, agent, team, NOW]
    );
  question(null, "t1");
  expect(() => question("a1", "t1")).toThrow();
  expect(() => question(null, null)).toThrow();
});
