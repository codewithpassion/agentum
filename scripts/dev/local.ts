// Shared helpers for the dev scripts that work on the local D1 database that
// `bun run dev` in apps/web uses. The database is the newest SQLite file under
// apps/web/.wrangler, opened with bun:sqlite and foreign keys on. Run the
// scripts from the repo root.
import { Database as Sqlite } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "@repo/db";
import { sqliteAtomic } from "@repo/db/atomic";
import { type Blobs, createEventsService } from "@repo/services/events";
import { createMachinesService } from "@repo/services/machines";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { createWorkspacesService } from "@repo/services/workspaces";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";

export const WEB_DIR = join(import.meta.dir, "..", "..", "apps", "web");
export const ENV_FILE = join(WEB_DIR, ".env.local");
/** The D1 folder under a wrangler state folder (`.wrangler/state` or a `--persist-to` path). */
export const d1DirOf = (stateDir: string): string =>
  join(stateDir, "v3", "d1", "miniflare-D1DatabaseObject");
export const D1_DIR = d1DirOf(join(WEB_DIR, ".wrangler", "state"));
export const WORKSPACE_NAME = "Dev Workspace";
const DEV_USER_ID = "dev-script";

/** A problem the developer can fix by changing the local setup. */
export class LocalError extends Error {}

/** Blob storage in memory, for events and payloads a dev script writes. */
export const memoryBlobs = (): Blobs => {
  const store = new Map<string, string>();
  return {
    get: (key) => Promise.resolve(store.get(key) ?? null),
    put: (key, body) => {
      store.set(key, body);
      return Promise.resolve();
    },
  };
};

/**
 * The Clerk org id of the oldest workspace in the local database, or null when
 * there is no database or no workspace yet. A dev login or `bun run
 * add-workspace --local` makes the first one.
 */
export const readOrgId = (d1Dir: string = D1_DIR): string | null => {
  const file = findLocalD1(d1Dir);
  if (!file) {
    return null;
  }
  const client = openSqlite(file);
  try {
    const row = client
      .query<{ id: string }, []>(
        "SELECT clerk_org_id AS id FROM workspaces ORDER BY created_at, id LIMIT 1"
      )
      .get();
    return row?.id ?? null;
  } finally {
    client.close();
  }
};

/** The org id from `readOrgId`, or a LocalError that says how to make a workspace. */
export const requireOrgId = (): string => {
  const orgId = readOrgId();
  if (!orgId) {
    throw new LocalError(
      `The local database in ${D1_DIR} has no workspace. Sign in once with the dev login, or run \`bun run add-workspace --org <id> --name <name> --local\` in apps/web.`
    );
  }
  return orgId;
};

/** The newest `*.sqlite` file in the local D1 state dir, except metadata. */
export const findLocalD1 = (dir: string): string | null => {
  if (!existsSync(dir)) {
    return null;
  }
  const candidates = readdirSync(dir)
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
};

/** How long a write waits for the Worker's write lock before it fails. */
export const BUSY_TIMEOUT_MS = 5000;

/** Opens a SQLite file with foreign keys on and a busy timeout. */
export const openSqlite = (file: string): Sqlite => {
  const client = new Sqlite(file);
  client.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  client.run("PRAGMA foreign_keys = ON");
  return client;
};

/**
 * Opens the local database with foreign keys on, as D1 has them, and waits for
 * a locked database instead of failing. The caller calls `close` when done.
 * Throws a LocalError when there is no database yet.
 */
export const openLocalDatabase = (
  d1Dir: string = D1_DIR
): {
  close: () => void;
  db: BunSQLiteDatabase;
  file: string;
} => {
  const file = findLocalD1(d1Dir);
  if (!file) {
    throw new LocalError(
      `No local D1 database in ${d1Dir}. Run \`bunx wrangler d1 migrations apply DB --local\` in apps/web first.`
    );
  }
  const client = openSqlite(file);
  return {
    close: () => client.close(),
    db: drizzle(client),
    file,
  };
};

/** The dev workspace's user principal. Makes the workspace row when the org has none. */
export const devUserPrincipal = async (
  db: Database,
  orgId: string
): Promise<Extract<Principal, { kind: "user" }>> => {
  const workspace = await createWorkspacesService({ db }).create({
    clerkOrgId: orgId,
    name: WORKSPACE_NAME,
  });
  return {
    kind: "user",
    userId: DEV_USER_ID,
    via: "session",
    workspaceId: workspace.id,
  };
};

/** The events service over the local database, with in-memory blobs. */
export const localEvents = (db: Database) =>
  createEventsService({ blobs: memoryBlobs(), db });

/** The machines service over the local database, with a no-op relay. */
export const localMachines = (db: BunSQLiteDatabase) =>
  createMachinesService({
    atomic: sqliteAtomic(db),
    clock: systemClock,
    db,
    events: localEvents(db),
    relay: noopRelay,
  });

/** Runs a script's main, printing a failure on stderr and exiting with 1. */
export const runCli = (main: () => Promise<void>): void => {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : `Failed: ${String(error)}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
};
