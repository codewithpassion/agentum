#!/usr/bin/env bun
// Lists the machines of the dev workspace in the local D1 database, with the
// 20 newest machine presence events, on stdout. Errors go to stderr. Run from
// the repo root: `bun scripts/dev/machines.ts`.
import type { Database } from "@repo/db";
import {
  EVENT_QUERY_MAX_LIMIT,
  type EventRecord,
  type EventsService,
} from "@repo/services/events";
import type { MachineRecord } from "@repo/services/machines";
import type { Principal } from "@repo/services/workspaces";
import {
  devUserPrincipal,
  localEvents,
  localMachines,
  openLocalDatabase,
  requireOrgId,
  runCli,
} from "./local.ts";

const EVENT_TYPES = ["machine.online", "machine.offline"] as const;
const EVENT_COUNT = 20;

const machineLine = (machine: MachineRecord): string =>
  [
    machine.id,
    machine.name,
    machine.status,
    `single_user=${machine.singleUser}`,
    `last_seen_at=${machine.lastSeenAt ?? "never"}`,
  ].join("  ");

/** The newest `count` machine presence events, oldest first. */
const newestEvents = (
  events: EventsService,
  principal: Principal,
  workspaceId: string,
  count: number
): Promise<EventRecord[]> => {
  // `query` returns the oldest matching events first, so walk every page and
  // keep only the tail.
  const walk = async (
    after: string | undefined,
    tail: EventRecord[]
  ): Promise<EventRecord[]> => {
    const page = await events.query(principal, workspaceId, {
      after,
      limit: EVENT_QUERY_MAX_LIMIT,
      types: [...EVENT_TYPES],
    });
    const kept = [...tail, ...page].slice(-count);
    const last = page.at(-1);
    return page.length === EVENT_QUERY_MAX_LIMIT && last
      ? walk(last.id, kept)
      : kept;
  };
  return walk(undefined, []);
};

const eventLine = (event: EventRecord): string => {
  const { machineId, reason } = event.payload;
  return [
    event.createdAt,
    event.type,
    String(machineId ?? "-"),
    typeof reason === "string" ? reason : "-",
  ].join("  ");
};

/** The text `bun scripts/dev/machines.ts` prints for the dev workspace of `orgId`. */
export const describeMachines = async (
  db: Database,
  orgId: string
): Promise<string> => {
  const principal = await devUserPrincipal(db, orgId);
  const machines = await localMachines(db, orgId).list(principal);
  const machineBlock =
    machines.length === 0
      ? "No machines."
      : machines.map(machineLine).join("\n");

  const events = await newestEvents(
    localEvents(db),
    principal,
    principal.workspaceId,
    EVENT_COUNT
  );
  const eventBlock =
    events.length === 0
      ? "No machine events."
      : events.map(eventLine).join("\n");

  return `${machineBlock}\n\n${eventBlock}\n`;
};

export const main = async (): Promise<void> => {
  const orgId = requireOrgId();
  const local = openLocalDatabase();
  try {
    process.stdout.write(await describeMachines(local.db, orgId));
  } finally {
    local.close();
  }
};

if (import.meta.main) {
  runCli(main);
}
