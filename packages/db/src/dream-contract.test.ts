import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents } from "./schema/agents.ts";
import { triggers } from "./schema/triggers.ts";
import { workspaces } from "./schema/workspaces.ts";
import {
  DEFAULT_DREAM_COUNTS_JSON,
  DREAM_MODEL,
  DREAM_QUESTION_STATUSES,
  DREAM_RUN_STATUSES,
  NEEDS_YOU_HEADINGS,
  NEEDS_YOU_KINDS,
} from "./shared.ts";
import { migrated } from "./test-db.ts";

const NOW = "2026-01-01T00:00:00.000Z";

interface Column {
  name: string;
  notnull: number;
}

const DREAM_RUNS_NOT_NULL = [
  "agent_id",
  "base_version",
  "counts",
  "diary",
  "id",
  "started_at",
  "status",
  "workspace_id",
];

const DREAM_RUNS_COLUMNS = [
  "agent_id",
  "base_version",
  "counts",
  "diary",
  "error",
  "finished_at",
  "id",
  "result_version",
  "since",
  "started_at",
  "status",
  "usage",
  "workspace_id",
];

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

const dreamTrigger = (id: string, agentId: string) => ({
  agentId,
  createdAt: NOW,
  createdBy: "u1",
  id,
  kind: "dream" as const,
  name: `dream ${id}`,
  workspaceId: "w1",
});

const seedWorkspace = (db: ReturnType<typeof migrated>) => {
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: NOW,
      id: "w1",
      name: "w1",
      timezone: "UTC",
    })
    .run();
};

test("dream_runs has exactly the documented columns, NOT NULL where the design says", () => {
  const { client } = migrated();
  const columns = client
    .query<Column, []>("PRAGMA table_info(dream_runs)")
    .all();

  expect(columns.map((c) => c.name).sort()).toEqual(
    [...DREAM_RUNS_COLUMNS].sort()
  );
  for (const column of columns) {
    const notNull = DREAM_RUNS_NOT_NULL.includes(column.name);
    expect(column.notnull, column.name).toBe(notNull ? 1 : 0);
  }
});

test("a minimal dream run insert takes the database defaults", () => {
  const { client } = migrated();
  client.run(
    "INSERT INTO workspaces (id, clerk_org_id, created_at, name, timezone) VALUES ('w1', 'org_w1', ?, 'w1', 'UTC')",
    [NOW]
  );
  client.run(
    "INSERT INTO agents (id, workspace_id, created_at, created_by, instructions, model, name, runtime, runtime_config, slug, status) VALUES ('a1', 'w1', ?, 'u1', '', 'm', 'a1', 'fake', '{}', 'a1', 'active')",
    [NOW]
  );
  client.run(
    "INSERT INTO dream_runs (id, workspace_id, agent_id, started_at, status) VALUES ('d1', 'w1', 'a1', ?, 'running')",
    [NOW]
  );
  const row = client
    .query<{ base_version: string; counts: string; diary: string }, []>(
      "SELECT base_version, counts, diary FROM dream_runs WHERE id = 'd1'"
    )
    .get();

  expect(row?.base_version).toBe("[]");
  expect(row?.diary).toBe("");
  expect(row?.counts).toBe(DEFAULT_DREAM_COUNTS_JSON);
  expect(JSON.parse(row?.counts ?? "null")).toEqual({
    added: 0,
    dropped: 0,
    merged: 0,
    questions: 0,
  });
});

test("the dream run statuses, model and Needs you kind are the documented values", () => {
  expect([...DREAM_RUN_STATUSES]).toEqual([
    "running",
    "done",
    "skipped",
    "failed",
    "undone",
  ]);
  expect(DREAM_MODEL.length).toBeGreaterThan(0);
  expect(NEEDS_YOU_KINDS).toContain("dream_question");
  const heading = NEEDS_YOU_HEADINGS.dream_question("Scout");
  expect(heading.length).toBeGreaterThan(0);
  expect(heading).toContain("Scout");
});

test("two live dream triggers for one agent are refused", () => {
  const db = migrated();
  seedWorkspace(db);
  db.insert(agents).values(agent("a1")).run();
  db.insert(triggers).values(dreamTrigger("t1", "a1")).run();

  expect(() =>
    db.insert(triggers).values(dreamTrigger("t2", "a1")).run()
  ).toThrow();
});

test("a dream trigger can be added again once the first is revoked", () => {
  const db = migrated();
  seedWorkspace(db);
  db.insert(agents).values(agent("a1")).run();
  db.insert(triggers).values(dreamTrigger("t1", "a1")).run();
  db.update(triggers)
    .set({ revokedAt: NOW })
    .where(eq(triggers.id, "t1"))
    .run();

  db.insert(triggers).values(dreamTrigger("t2", "a1")).run();

  const live = db
    .select({ id: triggers.id })
    .from(triggers)
    .where(eq(triggers.agentId, "a1"))
    .all()
    .map((row) => row.id)
    .sort();
  expect(live).toEqual(["t1", "t2"]);
});

test("two agents may each have one dream trigger", () => {
  const db = migrated();
  seedWorkspace(db);
  db.insert(agents).values(agent("a1")).run();
  db.insert(agents).values(agent("a2")).run();

  db.insert(triggers).values(dreamTrigger("t1", "a1")).run();
  db.insert(triggers).values(dreamTrigger("t2", "a2")).run();

  const rows = db
    .select({ id: triggers.id })
    .from(triggers)
    .where(eq(triggers.kind, "dream"))
    .all();
  expect(rows.length).toBe(2);
});

test("dream_questions has the documented columns and refuses a missing dream run", () => {
  const { client } = migrated();
  const columns = client
    .query<Column, []>("PRAGMA table_info(dream_questions)")
    .all();

  expect(columns.map((c) => c.name).sort()).toEqual([
    "agent_id",
    "answered_at",
    "answered_by",
    "answered_note_id",
    "created_at",
    "dream_run_id",
    "id",
    "options",
    "question",
    "status",
    "workspace_id",
  ]);
  const nullable = ["answered_at", "answered_by", "answered_note_id"];
  for (const column of columns) {
    expect(column.notnull, column.name).toBe(
      nullable.includes(column.name) ? 0 : 1
    );
  }
  expect(DREAM_QUESTION_STATUSES).toEqual(["open", "answered"]);
});

test("a dream question needs its dream run", () => {
  const { client } = migrated();
  client.run("PRAGMA foreign_keys = ON");
  client.run(
    "INSERT INTO workspaces (id, clerk_org_id, created_at, name, timezone) VALUES ('w1', 'org_w1', ?, 'w1', 'UTC')",
    [NOW]
  );
  client.run(
    "INSERT INTO agents (id, workspace_id, created_at, created_by, instructions, model, name, runtime, runtime_config, slug, status) VALUES ('a1', 'w1', ?, 'u1', '', 'm', 'a1', 'fake', '{}', 'a1', 'active')",
    [NOW]
  );
  const insertQuestion = () =>
    client.run(
      "INSERT INTO dream_questions (id, workspace_id, agent_id, dream_run_id, created_at, options, question, status) VALUES ('q1', 'w1', 'a1', 'd1', ?, '[]', 'Which?', 'open')",
      [NOW]
    );

  expect(insertQuestion).toThrow();
  client.run(
    "INSERT INTO dream_runs (id, workspace_id, agent_id, started_at, status) VALUES ('d1', 'w1', 'a1', ?, 'done')",
    [NOW]
  );
  insertQuestion();
  const row = client
    .query<{ status: string }, []>("SELECT status FROM dream_questions")
    .get();
  expect(row?.status).toBe("open");
});
