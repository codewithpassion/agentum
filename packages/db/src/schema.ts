// The tables. `drizzle-kit generate` diffs this file against the last snapshot
// in migrations/, so every change here needs a new migration generated with it.
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Any drizzle SQLite instance, which is what every query function takes. D1
 * (`drizzle-orm/d1`) is async and `bun:sqlite` (`drizzle-orm/bun-sqlite`, used
 * by the tests) is sync; both satisfy this, and awaiting works either way.
 */
export type Database = BaseSQLiteDatabase<"sync" | "async", unknown>;

export const notes = sqliteTable("notes", {
  // ISO 8601 UTC. Text because that is the shape that leaves this package
  // anyway, and it still sorts chronologically.
  createdAt: text("created_at").notNull(),
  // Autoincrement, so the id also orders rows by insertion. Two notes written
  // in the same millisecond still come back in the order they were added, and
  // "newest first" needs no index beyond the primary key.
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
});
