// Shared helpers for the dev scripts that work on the local D1 database that
// `bun run dev` in apps/web uses. The database is the newest SQLite file under
// apps/web/.wrangler, opened with bun:sqlite and foreign keys on. Run the
// scripts from the repo root.
import { Database as Sqlite } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "@repo/db";
import { type Blobs, createEventsService } from "@repo/services/events";
import { createMachinesService } from "@repo/services/machines";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { createWorkspacesService } from "@repo/services/workspaces";
import { drizzle } from "drizzle-orm/bun-sqlite";

export const WEB_DIR = join(import.meta.dir, "..", "..", "apps", "web");
export const ENV_FILE = join(WEB_DIR, ".env.local");
export const D1_DIR = join(
  WEB_DIR,
  ".wrangler",
  "state",
  "v3",
  "d1",
  "miniflare-D1DatabaseObject"
);
export const ORG_KEY = "ALLOWED_ORG_IDS";
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

/** The first org id in a comma separated `ALLOWED_ORG_IDS` value, or null. */
export const firstOrgId = (value: string): string | null =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "") ?? null;

/** The value of the `ALLOWED_ORG_IDS=` line in an env file, or undefined. */
const orgIdsFromEnvFile = (text: string): string | undefined => {
  const line = text
    .split("\n")
    .find((candidate) => candidate.startsWith(`${ORG_KEY}=`));
  return line?.slice(ORG_KEY.length + 1);
};

/** The first allowed org id from the environment or `.env.local`, or null. */
export const readOrgId = (): string | null => {
  const value =
    process.env[ORG_KEY] ??
    (existsSync(ENV_FILE)
      ? orgIdsFromEnvFile(readFileSync(ENV_FILE, "utf8"))
      : undefined);
  return value === undefined ? null : firstOrgId(value);
};

/** The org id from `readOrgId`, or a LocalError that says how to set it. */
export const requireOrgId = (): string => {
  const orgId = readOrgId();
  if (!orgId) {
    throw new LocalError(
      `ALLOWED_ORG_IDS is not set in ${ENV_FILE}. Run \`bun run create-dev-user\` in apps/web first.`
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

/**
 * Opens the local database with foreign keys on, as D1 has them. The caller
 * calls `close` when done. Throws a LocalError when there is no database yet.
 */
export const openLocalDatabase = (): {
  close: () => void;
  db: Database;
  file: string;
} => {
  const file = findLocalD1(D1_DIR);
  if (!file) {
    throw new LocalError(
      `No local D1 database in ${D1_DIR}. Run \`bunx wrangler d1 migrations apply DB --local\` in apps/web first.`
    );
  }
  const client = new Sqlite(file);
  client.run("PRAGMA foreign_keys = ON");
  return {
    close: () => client.close(),
    db: drizzle(client),
    file,
  };
};

/** The dev workspace's user principal. Creates the workspace on first use. */
export const devUserPrincipal = async (
  db: Database,
  orgId: string
): Promise<Extract<Principal, { kind: "user" }>> => {
  const workspace = await createWorkspacesService({
    allowedOrgIds: [orgId],
    db,
  }).forOrg({ clerkOrgId: orgId, name: WORKSPACE_NAME });
  if (!workspace) {
    throw new LocalError(`Organisation ${orgId} is not allowed.`);
  }
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

/** The machines service for the dev org, with a no-op relay. */
export const localMachines = (db: Database, orgId: string) =>
  createMachinesService({
    allowedOrgIds: [orgId],
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
