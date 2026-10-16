#!/usr/bin/env bun
// Seeds the local D1 database that `bun run dev` in apps/web uses with the
// dev workspace and a fake-runtime agent, then prints the agent's id on
// stdout. Progress and errors go to stderr. Run from the repo root.
import { Database as Sqlite } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "@repo/db";
import { createAgentsService } from "@repo/services/agents";
import { type Blobs, createEventsService } from "@repo/services/events";
import type { Principal } from "@repo/services/workspaces";
import { createWorkspacesService } from "@repo/services/workspaces";
import { drizzle } from "drizzle-orm/bun-sqlite";

const WEB_DIR = join(import.meta.dir, "..", "..", "apps", "web");
const ENV_FILE = join(WEB_DIR, ".env.local");
const D1_DIR = join(
  WEB_DIR,
  ".wrangler",
  "state",
  "v3",
  "d1",
  "miniflare-D1DatabaseObject"
);
const ORG_KEY = "ALLOWED_ORG_IDS";
const WORKSPACE_NAME = "Dev Workspace";
const SEED_USER_ID = "seed-script";
const AGENT_SLUG = "fake-echo";

class SeedError extends Error {}

const memoryBlobs = (): Blobs => {
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

const readOrgId = (): string | null => {
  const value =
    process.env[ORG_KEY] ??
    (existsSync(ENV_FILE)
      ? orgIdsFromEnvFile(readFileSync(ENV_FILE, "utf8"))
      : undefined);
  return value === undefined ? null : firstOrgId(value);
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
 * Creates the workspace for `orgId` and the fake agent in it, or finds the
 * fake agent from an earlier run. Returns the agent id.
 */
export const seedFakeAgent = async ({
  db,
  orgId,
}: {
  db: Database;
  orgId: string;
}): Promise<string> => {
  const workspace = await createWorkspacesService({
    allowedOrgIds: [orgId],
    db,
  }).forOrg({ clerkOrgId: orgId, name: WORKSPACE_NAME });
  if (!workspace) {
    throw new SeedError(`Organisation ${orgId} is not allowed.`);
  }

  const principal: Principal = {
    kind: "user",
    userId: SEED_USER_ID,
    via: "session",
    workspaceId: workspace.id,
  };
  const agents = createAgentsService({
    db,
    events: createEventsService({ blobs: memoryBlobs(), db }),
  });

  const existing = (
    await agents.list(principal, { includeArchived: true })
  ).find((agent) => agent.slug === AGENT_SLUG);
  if (existing) {
    if (existing.status === "archived") {
      process.stderr.write(
        `Agent ${AGENT_SLUG} (${existing.id}) is archived.\n`
      );
    }
    return existing.id;
  }

  const created = await agents.create(principal, {
    instructions: "Echoes whatever it is told.",
    model: "fake",
    name: "Fake echo",
    runtime: "fake",
    slug: AGENT_SLUG,
  });
  process.stderr.write(`Created agent ${AGENT_SLUG} (${created.id}).\n`);
  return created.id;
};

export const main = async (): Promise<void> => {
  const orgId = readOrgId();
  if (!orgId) {
    throw new SeedError(
      `ALLOWED_ORG_IDS is not set in ${ENV_FILE}. Run \`bun run create-dev-user\` in apps/web first.`
    );
  }
  const dbFile = findLocalD1(D1_DIR);
  if (!dbFile) {
    throw new SeedError(
      `No local D1 database in ${D1_DIR}. Run \`bunx wrangler d1 migrations apply DB --local\` in apps/web first.`
    );
  }

  process.stderr.write(`Seeding ${dbFile}.\n`);
  const client = new Sqlite(dbFile);
  // D1 enforces foreign keys, so the seed does too.
  client.run("PRAGMA foreign_keys = ON");
  try {
    const agentId = await seedFakeAgent({ db: drizzle(client), orgId });
    process.stdout.write(`${agentId}\n`);
  } finally {
    client.close();
  }
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : `Seeding failed: ${error}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
