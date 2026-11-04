import { Database as Sqlite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../migrations");
const BREAKPOINT = "--> statement-breakpoint";
const NOW = "2026-01-01T00:00:00.000Z";
const CIMD_CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";

const files = readdirSync(MIGRATIONS_FOLDER)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const targetIndex = files.findIndex((name) =>
  readFileSync(resolve(MIGRATIONS_FOLDER, name), "utf8").includes(
    "oauth_clients_client_workspace_unique"
  )
);

const apply = (client: Sqlite, name: string) => {
  const sql = readFileSync(resolve(MIGRATIONS_FOLDER, name), "utf8");
  for (const statement of sql.split(BREAKPOINT)) {
    client.run(statement);
  }
};

const insertClient = (client: Sqlite, id: string, workspaceId: string) => {
  client.run(
    `INSERT INTO oauth_clients (client_id, created_at, first_seen_by, id, workspace_id)
     VALUES (?, ?, 'u1', ?, ?)`,
    [CIMD_CLIENT, NOW, id, workspaceId]
  );
};

const rows = (client: Sqlite) =>
  client
    .query<{ id: string; workspace_id: string }, []>(
      "SELECT id, workspace_id FROM oauth_clients ORDER BY id"
    )
    .all();

test("the per-workspace OAuth client migration is among the migrations", () => {
  expect(targetIndex).toBeGreaterThan(0);
});

test("existing rows keep their workspace, and a client id may then repeat across workspaces only", () => {
  const client = new Sqlite(":memory:");
  client.run("PRAGMA foreign_keys = ON");
  for (const name of files.slice(0, targetIndex)) {
    apply(client, name);
  }
  for (const ws of ["w1", "w2"]) {
    client.run(
      `INSERT INTO workspaces (clerk_org_id, created_at, id, name, timezone)
       VALUES (?, ?, ?, ?, 'UTC')`,
      [`org_${ws}`, NOW, ws, ws]
    );
  }
  insertClient(client, "c1", "w1");
  // Before: one row per client id across the deployment.
  expect(() => insertClient(client, "c2", "w2")).toThrow();

  for (const name of files.slice(targetIndex)) {
    apply(client, name);
  }

  expect(rows(client)).toEqual([{ id: "c1", workspace_id: "w1" }]);
  insertClient(client, "c2", "w2");
  expect(rows(client)).toHaveLength(2);
  expect(() => insertClient(client, "c3", "w1")).toThrow();
});
