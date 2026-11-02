// Test helper: a throwaway in-memory SQLite database with the same migrations
// D1 gets, so no server and no network are involved. Foreign keys are on, as
// they always are in D1.
import { Database as Sqlite } from "bun:sqlite";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { workspaces } from "./schema/workspaces.ts";

// Relative to this file, not the working directory: `bun test` from the repo
// root would otherwise look for migrations there.
const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../migrations");

/**
 * A migrated database. `orgIds` are Clerk org ids that get a workspace row, the
 * way an organisation gets access in the app. A test of a user in `org_a` passes
 * `["org_a"]`. The row id is `ws_<org id>`.
 */
export const migrated = (orgIds: readonly string[] = []) => {
  const client = new Sqlite(":memory:");
  client.run("PRAGMA foreign_keys = ON");
  const db = drizzle(client);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  for (const clerkOrgId of orgIds) {
    db.insert(workspaces)
      .values({
        clerkOrgId,
        createdAt: new Date().toISOString(),
        id: `ws_${clerkOrgId}`,
        name: clerkOrgId,
        timezone: "UTC",
      })
      .onConflictDoNothing()
      .run();
  }
  return Object.assign(db, { client });
};
