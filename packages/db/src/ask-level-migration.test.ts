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
  readFileSync(resolve(MIGRATIONS_FOLDER, name), "utf8").includes("`ask_level`")
);

const apply = (client: Sqlite, name: string) => {
  const sql = readFileSync(resolve(MIGRATIONS_FOLDER, name), "utf8");
  for (const statement of sql.split(BREAKPOINT)) {
    client.run(statement);
  }
};

const seedAgent = (client: Sqlite, id: string) => {
  client.run(
    `INSERT INTO agents (created_at, created_by, id, instructions, model, name, runtime, runtime_config, slug, status, workspace_id)
     VALUES (?, 'u1', ?, '', 'm', ?, 'fake', '{}', ?, 'active', 'w1')`,
    [NOW, id, id, id]
  );
};

test("agents with tool rules become custom, the others take the default level", () => {
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
  seedAgent(client, "ruled");
  seedAgent(client, "plain");
  client.run(
    `INSERT INTO agent_tool_rules (agent_id, id, mode, tool_key, updated_at, updated_by, workspace_id)
     VALUES ('ruled', 'r1', 'allow', 'bash', ?, 'u1', 'w1')`,
    [NOW]
  );
  apply(client, files[targetIndex] ?? "");
  const levels = client
    .query<{ ask_level: string; id: string }, []>(
      "SELECT id, ask_level FROM agents ORDER BY id"
    )
    .all();
  expect(levels).toEqual([
    { ask_level: "rarely", id: "plain" },
    { ask_level: "custom", id: "ruled" },
  ]);
});
