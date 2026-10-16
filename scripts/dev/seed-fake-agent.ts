#!/usr/bin/env bun
// Seeds the local D1 database that `bun run dev` in apps/web uses with the
// dev workspace and a fake-runtime agent, then prints the agent's id on
// stdout. Progress and errors go to stderr. Run from the repo root.
import type { Database } from "@repo/db";
import { createAgentsService } from "@repo/services/agents";
import type { Principal } from "@repo/services/workspaces";
import {
  devUserPrincipal,
  localEvents,
  openLocalDatabase,
  requireOrgId,
  runCli,
} from "./local.ts";

const SEED_USER_ID = "seed-script";
const AGENT_SLUG = "fake-echo";

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
  const workspace = await devUserPrincipal(db, orgId);
  const principal: Principal = {
    ...workspace,
    userId: SEED_USER_ID,
  };
  const agents = createAgentsService({ db, events: localEvents(db) });

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
  const orgId = requireOrgId();
  const local = openLocalDatabase();
  process.stderr.write(`Seeding ${local.file}.\n`);
  try {
    const agentId = await seedFakeAgent({ db: local.db, orgId });
    process.stdout.write(`${agentId}\n`);
  } finally {
    local.close();
  }
};

if (import.meta.main) {
  runCli(main);
}
