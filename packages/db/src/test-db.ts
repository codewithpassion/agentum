// Test helper: a throwaway in-memory SQLite database with the same migrations
// D1 gets, so no server and no network are involved.
import { Database as Sqlite } from "bun:sqlite";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

// Relative to this file, not the working directory: `bun test` from the repo
// root would otherwise look for migrations there.
const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../migrations");

export const migrated = () => {
  const client = new Sqlite(":memory:");
  const db = drizzle(client);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return Object.assign(db, { client });
};
