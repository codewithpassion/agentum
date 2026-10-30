import { expect, test } from "bun:test";
import { NEEDS_YOU_HEADINGS, NEEDS_YOU_KINDS } from "./shared.ts";
import { migrated } from "./test-db.ts";

interface Column {
  dflt_value: string | null;
  name: string;
  notnull: number;
}

test("agents and runs gain the rail columns, nullable with no default", () => {
  const { client } = migrated();
  const columns = (table: string) =>
    client.query<Column, []>(`PRAGMA table_info(${table})`).all();
  const wanted: Record<string, string[]> = {
    agents: ["owner_user_id", "backup_user_id"],
    runs: ["attention_cleared_at", "attention_cleared_by"],
  };
  for (const [table, names] of Object.entries(wanted)) {
    for (const name of names) {
      const column = columns(table).find((c) => c.name === name);
      expect(column?.notnull).toBe(0);
      expect(column?.dflt_value).toBeNull();
    }
  }
});

test("the events triggers survive the rail migration", () => {
  const { client } = migrated();
  const names = client
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events'"
    )
    .all();
  expect(names.length).toBeGreaterThanOrEqual(2);
});

test("every needs-you kind has a heading", () => {
  for (const kind of NEEDS_YOU_KINDS) {
    expect(NEEDS_YOU_HEADINGS[kind]("Ada")).toContain("Ada");
  }
});
