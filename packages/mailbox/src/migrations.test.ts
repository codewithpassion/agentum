import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { applyMigrations, MAILBOX_MIGRATIONS } from "./migrations.ts";
import { testMailboxDb } from "./test-db.ts";

describe("applyMigrations", () => {
  test("creates the folders and tables", () => {
    const db = testMailboxDb();
    const folders = db
      .all<{ id: string }>(sql`SELECT id FROM folders ORDER BY id`)
      .map((row) => row.id);
    expect(folders).toEqual([
      "archive",
      "draft",
      "inbox",
      "sent",
      "spam",
      "trash",
    ]);
    const columns = db
      .all<{ name: string }>(sql`PRAGMA table_info(emails)`)
      .map((row) => row.name);
    expect(columns).toContain("dedupe_key");
    expect(columns).toContain("body_is_html");
  });

  test("is idempotent", () => {
    const db = testMailboxDb();
    applyMigrations(db);
    const [row] = db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM mailbox_migrations`
    );
    expect(row?.n).toBe(MAILBOX_MIGRATIONS.length);
  });

  test("rolls a failed migration back and leaves it unapplied", () => {
    const db = testMailboxDb();
    const broken = [
      {
        name: "99_broken",
        statements: ["CREATE TABLE half (id TEXT)", "NOT SQL"],
      },
    ];
    expect(() => applyMigrations(db, broken)).toThrow();
    const tables = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE name = 'half'`
    );
    expect(tables).toHaveLength(0);
  });

  test("a second delivery key conflicts on the unique index", () => {
    const db = testMailboxDb();
    const insert = () =>
      db.run(
        sql`INSERT INTO emails (id, folder_id, dedupe_key) VALUES (${crypto.randomUUID()}, 'inbox', 'k1')`
      );
    insert();
    expect(insert).toThrow();
  });
});
