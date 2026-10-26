// Test helper: a throwaway in-memory SQLite mailbox with its migrations
// applied. A Durable Object's SQLite cannot run under `bun test`, so the store
// is tested against bun:sqlite through the same drizzle surface.
import { Database as Sqlite } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "./migrations.ts";

export interface TestMailboxDbOptions {
  /** Throw on any statement that binds more parameters than this, as a Durable Object's SQLite does. */
  maxBoundParams?: number;
}

export const testMailboxDb = ({
  maxBoundParams,
}: TestMailboxDbOptions = {}) => {
  const client = new Sqlite(":memory:");
  // A Durable Object's SQLite enforces foreign keys, so the tests do too.
  client.run("PRAGMA foreign_keys = ON");
  const db = drizzle(client, {
    logger:
      maxBoundParams === undefined
        ? undefined
        : {
            logQuery: (query, params) => {
              if (params.length > maxBoundParams) {
                throw new Error(
                  `${params.length} bound parameters, the limit is ${maxBoundParams}: ${query}`
                );
              }
            },
          },
  });
  applyMigrations(db);
  return Object.assign(db, { client });
};
