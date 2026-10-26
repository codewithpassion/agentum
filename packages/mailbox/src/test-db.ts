// Test helper: a throwaway in-memory SQLite mailbox with its migrations
// applied. A Durable Object's SQLite cannot run under `bun test`, so the store
// is tested against bun:sqlite through the same drizzle surface.
import { Database as Sqlite } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "./migrations.ts";

export const testMailboxDb = () => {
  const client = new Sqlite(":memory:");
  // A Durable Object's SQLite enforces foreign keys, so the tests do too.
  client.run("PRAGMA foreign_keys = ON");
  const db = drizzle(client);
  applyMigrations(db);
  return Object.assign(db, { client });
};
