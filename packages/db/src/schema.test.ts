import { expect, test } from "bun:test";
import { migrated } from "./test-db.ts";

interface Column {
  dflt_value: string | null;
  name: string;
  notnull: number;
}

const NO_WORKSPACE_ID = new Set(["workspaces", "__drizzle_migrations"]);

test("the foundation tables and the two M0.1 stubs exist", () => {
  const { client } = migrated();
  const names = client
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name)
    .filter((name) => name !== "__drizzle_migrations");
  expect(names).toEqual([
    "agents",
    "api_keys",
    "events",
    "files",
    "identity_links",
    "machine_enroll_tokens",
    "machines",
    "runs",
    "sessions",
    "triggers",
    "workspaces",
  ]);
});

test("every table except workspaces has workspace_id NOT NULL with no default", () => {
  const { client } = migrated();
  const tables = client
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    )
    .all()
    .map((row) => row.name)
    .filter((name) => !NO_WORKSPACE_ID.has(name));
  expect(tables.length).toBe(10);

  for (const table of tables) {
    const column = client
      .query<Column, []>(`PRAGMA table_info(${table})`)
      .all()
      .find((c) => c.name === "workspace_id");
    expect(column?.notnull, table).toBe(1);
    expect(column?.dflt_value, table).toBeNull();
  }
});
