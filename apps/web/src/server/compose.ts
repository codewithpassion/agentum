// The composition root. It builds every service from the Worker's bindings and
// secrets, once per request (and once per minute tick). Kept free of Clerk and
// `cloudflare:workers` imports so bun can test it: callers pass `env` in.
//
// Lanes extend the app from here with one factory call each: add an adapter to
// `adapters` or a gateway to `gateways` below. Nothing else needs to know.
import type { Database } from "@repo/db";
import { type Atomic, d1Atomic } from "@repo/db/atomic";
import { type AgentsService, createAgentsService } from "@repo/services/agents";
import {
  type Blobs,
  createEventsService,
  type EventsService,
} from "@repo/services/events";
import {
  createMachinesService,
  type MachinesService,
} from "@repo/services/machines";
import { createMachineRuntime } from "@repo/services/machines/runtime";
import type { MachineRelayPort } from "@repo/services/machines/types";
import { createRunsService, type RunsService } from "@repo/services/runs";
import {
  type Clock,
  type Gateway,
  type RuntimeAdapter,
  systemClock,
} from "@repo/services/runs/types";
import { createWorkspacesService } from "@repo/services/workspaces";
import { drizzle } from "drizzle-orm/d1";
import { r2Blobs } from "./r2-blobs.ts";
import { durableRelayPort } from "./relay-port.ts";

/** What the runs service needs besides a database. */
export interface Infra {
  atomic: Atomic;
  blobs: Blobs;
  clock: Clock;
  devFakeRuntime: boolean;
  relay: MachineRelayPort;
}

export interface Services {
  agents: AgentsService;
  events: EventsService;
  machines: MachinesService;
  runs: RunsService;
  workspaces: ReturnType<typeof createWorkspacesService>;
}

export interface Composed {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  services: Services;
}

/** The bindings and secrets `compose` reads. */
export type ComposeEnv = Pick<
  Env,
  "ALLOWED_ORG_IDS" | "DB" | "FILES" | "MACHINE_RELAY"
>;

/** Splits a comma separated list of ids, trimmed, dropping empty entries. */
export const parseOrgIds = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

/** The services over a database and infra. Tests call this with fakes. */
export const composeWith = ({
  allowedOrgIds,
  db,
  infra,
}: {
  allowedOrgIds: readonly string[];
  db: Database;
  infra: Infra;
}): Composed => {
  // Lanes register here, by injection.
  const adapters: RuntimeAdapter[] = [
    createMachineRuntime({ relay: infra.relay }),
  ];
  const gateways: Gateway[] = [];

  const workspaces = createWorkspacesService({ allowedOrgIds, db });
  const events = createEventsService({ blobs: infra.blobs, db });
  const agents = createAgentsService({ db, events });
  const machines = createMachinesService({
    allowedOrgIds,
    clock: infra.clock,
    db,
    events,
    relay: infra.relay,
  });
  const runs = createRunsService({
    adapters,
    atomic: infra.atomic,
    blobs: infra.blobs,
    clock: infra.clock,
    db,
    devFakeRuntime: infra.devFakeRuntime,
    gateways,
  });
  return {
    atomic: infra.atomic,
    clock: infra.clock,
    db,
    services: { agents, events, machines, runs, workspaces },
  };
};

/**
 * The app's services on D1 and R2. The fake runtime is on in dev builds only,
 * so the caller passes `import.meta.env.DEV`.
 */
export const compose = (env: ComposeEnv, devFakeRuntime: boolean): Composed => {
  const db = drizzle(env.DB);
  return composeWith({
    allowedOrgIds: parseOrgIds(env.ALLOWED_ORG_IDS),
    db,
    infra: {
      atomic: d1Atomic(db),
      blobs: r2Blobs(env.FILES),
      clock: systemClock,
      devFakeRuntime,
      relay: durableRelayPort(env.MACHINE_RELAY),
    },
  });
};
