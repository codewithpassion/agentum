import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

/**
 * Any drizzle SQLite instance, which is what every query function takes. D1
 * (`drizzle-orm/d1`) is async and `bun:sqlite` (`drizzle-orm/bun-sqlite`, used
 * by the tests) is sync; both satisfy this, and awaiting works either way.
 */
export type Database = BaseSQLiteDatabase<"sync" | "async", unknown>;
