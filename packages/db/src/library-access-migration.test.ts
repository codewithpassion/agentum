import { Database as Sqlite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../migrations");
const BREAKPOINT = "--> statement-breakpoint";
const NOW = "2026-01-01T00:00:00.000Z";
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

const files = readdirSync(MIGRATIONS_FOLDER)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const targetIndex = files.findIndex((name) =>
  readFileSync(resolve(MIGRATIONS_FOLDER, name), "utf8").includes(
    "CREATE TABLE `agent_library_access`"
  )
);

const apply = (client: Sqlite, name: string) => {
  const sql = readFileSync(resolve(MIGRATIONS_FOLDER, name), "utf8");
  for (const statement of sql.split(BREAKPOINT)) {
    client.run(statement);
  }
};

const seedAgent = (
  client: Sqlite,
  id: string,
  runtimeConfig: string,
  status = "active"
) => {
  client.run(
    `INSERT INTO agents (created_at, created_by, id, instructions, model, name, runtime, runtime_config, slug, status, workspace_id)
     VALUES (?, 'u1', ?, '', 'm', ?, 'fake', ?, ?, ?, 'w1')`,
    [NOW, id, id, runtimeConfig, id, status]
  );
};

// The database as it was before the library access migration, with agents in it.
const beforeMigration = () => {
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
  return client;
};

const grants = (client: Sqlite) =>
  client
    .query<{ agent_id: string; mode: string; path: string }, []>(
      "SELECT agent_id, mode, path FROM agent_library_access ORDER BY agent_id, path"
    )
    .all();

test("the access migration is among the migrations", () => {
  expect(targetIndex).toBeGreaterThan(0);
});

test("libraryPaths become write grants, cleaned, for every agent", () => {
  const client = beforeMigration();
  seedAgent(client, "a1", '{"libraryPaths":["shared/docs","/clients/acme/"]}');
  seedAgent(client, "a2", '{"libraryPaths":["shared/docs"]}', "archived");
  seedAgent(client, "a3", '{"libraryPaths":["drafts"]}', "draft");
  apply(client, files[targetIndex] as string);
  expect(grants(client)).toEqual([
    { agent_id: "a1", mode: "write", path: "clients/acme" },
    { agent_id: "a1", mode: "write", path: "shared/docs" },
    { agent_id: "a2", mode: "write", path: "shared/docs" },
    { agent_id: "a3", mode: "write", path: "drafts" },
  ]);
  const row = client
    .query<{ created_at: string; workspace_id: string }, []>(
      "SELECT created_at, workspace_id FROM agent_library_access LIMIT 1"
    )
    .get();
  expect(row?.workspace_id).toBe("w1");
  expect(row?.created_at).toMatch(ISO_TIMESTAMP);
});

test("empty paths, non-text entries, a missing key and a non-list are skipped", () => {
  const client = beforeMigration();
  seedAgent(client, "a1", '{"libraryPaths":["", "/", 5, null, {"x":1}, "ok"]}');
  seedAgent(client, "a2", "{}");
  seedAgent(client, "a3", '{"libraryPaths":"shared"}');
  seedAgent(client, "a4", '{"libraryPaths":{"a":"shared"}}');
  seedAgent(client, "a5", "not json");
  apply(client, files[targetIndex] as string);
  expect(grants(client)).toEqual([
    { agent_id: "a1", mode: "write", path: "ok" },
  ]);
});

test("duplicates collapse and running the copy twice is safe", () => {
  const client = beforeMigration();
  seedAgent(client, "a1", '{"libraryPaths":["docs","/docs/","docs"]}');
  apply(client, files[targetIndex] as string);
  expect(grants(client)).toHaveLength(1);
  const sql = readFileSync(
    resolve(MIGRATIONS_FOLDER, files[targetIndex] as string),
    "utf8"
  );
  const copy = sql.split(BREAKPOINT).at(-1) as string;
  client.run(copy);
  expect(grants(client)).toHaveLength(1);
});

test("the events triggers survive the migration", () => {
  const client = beforeMigration();
  apply(client, files[targetIndex] as string);
  const triggers = client
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name"
    )
    .all()
    .map((row) => row.name);
  expect(triggers).toEqual(["events_no_delete", "events_no_update"]);
});
