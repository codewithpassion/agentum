// Builds a tRPC context from a database and a Clerk session. Kept free of
// Clerk and cloudflare:workers imports so bun can test it directly.
import type { Database } from "@repo/db";
import { type Atomic, d1Atomic } from "@repo/db/atomic";
import { createAgentsService } from "@repo/services/agents";
import { type Blobs, createEventsService } from "@repo/services/events";
import { createRunsService } from "@repo/services/runs";
import { type Clock, systemClock } from "@repo/services/runs/types";
import { createWorkspacesService } from "@repo/services/workspaces";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Context } from "./context.ts";

/** What the runs service needs besides a database. */
export interface Infra {
  atomic: Atomic;
  blobs: Blobs;
  clock: Clock;
  devFakeRuntime: boolean;
}

/**
 * Blobs until the R2 FILES binding lands (M0.7): any use fails loudly instead
 * of dropping an oversized event payload.
 */
export const unboundBlobs: Blobs = {
  get: () => Promise.reject(new Error("The FILES R2 bucket is not bound yet")),
  put: () => Promise.reject(new Error("The FILES R2 bucket is not bound yet")),
};

/** The app's infra on D1. The fake runtime is on in dev builds only. */
export const d1Infra = (
  db: DrizzleD1Database,
  devFakeRuntime: boolean
): Infra => ({
  atomic: d1Atomic(db),
  blobs: unboundBlobs,
  clock: systemClock,
  devFakeRuntime,
});

/** Splits a comma separated list of ids, trimmed, dropping empty entries. */
export const parseOrgIds = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

export const buildContext = async ({
  allowedOrgIds,
  db,
  infra,
  session,
}: {
  allowedOrgIds: readonly string[];
  db: Database;
  infra: Infra;
  session: { orgId?: string | null; userId: string | null };
}): Promise<Context> => {
  const workspaces = createWorkspacesService({ allowedOrgIds, db });
  const events = createEventsService({ blobs: infra.blobs, db });
  const agents = createAgentsService({ db, events });
  const runs = createRunsService({
    adapters: [],
    atomic: infra.atomic,
    blobs: infra.blobs,
    clock: infra.clock,
    db,
    devFakeRuntime: infra.devFakeRuntime,
    gateways: [],
  });
  const principal =
    session.userId === null
      ? null
      : await workspaces.sessionPrincipal({
          orgId: session.orgId,
          userId: session.userId,
        });
  return { principal, services: { agents, runs, workspaces } };
};
