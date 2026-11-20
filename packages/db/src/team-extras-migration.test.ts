import { Database as Sqlite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../migrations");
const BREAKPOINT = "--> statement-breakpoint";
const NOW = "2026-01-01T00:00:00.000Z";

const files = readdirSync(MIGRATIONS_FOLDER)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const targetIndex = files.findIndex((name) =>
  readFileSync(resolve(MIGRATIONS_FOLDER, name), "utf8").includes(
    "CREATE TABLE `discussions`"
  )
);

/** One migration in one transaction, the way wrangler and drizzle apply it. */
const apply = (client: Sqlite, name: string) => {
  const sql = readFileSync(resolve(MIGRATIONS_FOLDER, name), "utf8");
  client.run("BEGIN");
  for (const statement of sql.split(BREAKPOINT)) {
    client.run(statement);
  }
  client.run("COMMIT");
};

test("rows in dream_runs, dream_questions and memory_changes survive the nullable agent", () => {
  expect(targetIndex).toBeGreaterThan(0);
  const client = new Sqlite(":memory:");
  client.run("PRAGMA foreign_keys = ON");
  for (const name of files.slice(0, targetIndex)) {
    apply(client, name);
  }
  client.run(
    `INSERT INTO workspaces (clerk_org_id, created_at, id, name, timezone)
     VALUES ('org_w1', ?, 'w1', 'w1', 'UTC')`,
    [NOW]
  );
  client.run(
    `INSERT INTO agents (created_at, created_by, id, instructions, model, name, runtime, runtime_config, slug, status, workspace_id)
     VALUES (?, 'u1', 'a1', '', 'm', 'a1', 'fake', '{}', 'a1', 'active', 'w1')`,
    [NOW]
  );
  client.run(
    `INSERT INTO dream_runs (agent_id, id, started_at, status, workspace_id)
     VALUES ('a1', 'd1', ?, 'done', 'w1')`,
    [NOW]
  );
  client.run(
    `INSERT INTO dream_questions (agent_id, created_at, dream_run_id, id, options, question, status, workspace_id)
     VALUES ('a1', ?, 'd1', 'q1', '[]', 'which?', 'open', 'w1')`,
    [NOW]
  );
  client.run(
    `INSERT INTO memory_changes (action, agent_id, created_at, id, kind, note_id, status, text, workspace_id, written_by)
     VALUES ('add', 'a1', ?, 'c1', 'fact', 'n1', 'applied', 'text', 'w1', 'agent')`,
    [NOW]
  );

  apply(client, files[targetIndex] ?? "");

  expect(
    client.query("SELECT id, agent_id, team_id FROM dream_runs").all()
  ).toEqual([{ agent_id: "a1", id: "d1", team_id: null }]);
  expect(
    client.query("SELECT id, agent_id, team_id FROM memory_changes").all()
  ).toEqual([{ agent_id: "a1", id: "c1", team_id: null }]);
  expect(client.query("SELECT id FROM dream_questions").all()).toEqual([
    { id: "q1" },
  ]);
  expect(client.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("a team row has no agent", () => {
  const client = new Sqlite(":memory:");
  client.run("PRAGMA foreign_keys = ON");
  for (const name of files.slice(0, targetIndex + 1)) {
    apply(client, name);
  }
  client.run(
    `INSERT INTO workspaces (clerk_org_id, created_at, id, name, timezone)
     VALUES ('org_w1', ?, 'w1', 'w1', 'UTC')`,
    [NOW]
  );
  client.run(
    `INSERT INTO teams (created_at, id, name, rules, slug, workspace_id)
     VALUES (?, 't1', 't1', '', 't1', 'w1')`,
    [NOW]
  );
  client.run(
    `INSERT INTO dream_runs (id, started_at, status, team_id, workspace_id)
     VALUES ('d1', ?, 'running', 't1', 'w1')`,
    [NOW]
  );
  client.run(
    `INSERT INTO memory_changes (action, created_at, id, kind, note_id, status, team_id, text, workspace_id, written_by)
     VALUES ('add', ?, 'c1', 'fact', 'n1', 'applied', 't1', 'text', 'w1', 'dream')`,
    [NOW]
  );
  expect(client.query("SELECT count(*) AS n FROM dream_runs").get()).toEqual({
    n: 1,
  });
});
