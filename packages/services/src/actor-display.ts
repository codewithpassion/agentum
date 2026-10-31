import type { Database } from "@repo/db";
import { a2aConnections } from "@repo/db/schema/a2a";
import { guestIdentities } from "@repo/db/schema/live-artifacts";
import { and, eq, inArray } from "drizzle-orm";
import type { EventRecord, PeopleLookup } from "./events.ts";

/** One resolver for history, replay and live publication. Never reads payload identities or email. */
export const resolveActorDisplays = async (
  db: Database,
  people: PeopleLookup | undefined,
  records: readonly EventRecord[]
): Promise<EventRecord[]> => {
  const userIds = [
    ...new Set(
      records.filter((r) => r.actor.kind === "user").map((r) => r.actor.id)
    ),
  ];
  const names =
    people && userIds.length
      ? await people(userIds).catch(() => new Map())
      : new Map();
  const guests = new Map<string, string>();
  const workspaces = [...new Set(records.map((r) => r.workspaceId))];
  for (const workspaceId of workspaces) {
    const ids = [
      ...new Set(
        records
          .filter(
            (r) => r.workspaceId === workspaceId && r.actor.kind === "guest"
          )
          .map((r) => r.actor.id)
      ),
    ];
    if (!ids.length) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: keep guest lookups bound to each authenticated workspace
    const rows = await db
      .select({ id: guestIdentities.id, name: guestIdentities.displayName })
      .from(guestIdentities)
      .where(
        and(
          eq(guestIdentities.workspaceId, workspaceId),
          inArray(guestIdentities.id, ids)
        )
      );
    for (const row of rows) {
      guests.set(`${workspaceId}:${row.id}`, row.name);
    }
  }
  // A peer's id is its connection. Its name is the label we hold for it,
  // never anything the peer put in a message.
  const peers = new Map<string, string>();
  for (const workspaceId of workspaces) {
    const ids = [
      ...new Set(
        records
          .filter(
            (r) => r.workspaceId === workspaceId && r.actor.kind === "peer"
          )
          .map((r) => r.actor.id)
      ),
    ];
    if (!ids.length) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: keep peer lookups bound to each authenticated workspace
    const rows = await db
      .select({ id: a2aConnections.id, name: a2aConnections.peerLabel })
      .from(a2aConnections)
      .where(
        and(
          eq(a2aConnections.workspaceId, workspaceId),
          inArray(a2aConnections.id, ids)
        )
      );
    for (const row of rows) {
      if (row.name) {
        peers.set(`${workspaceId}:${row.id}`, row.name);
      }
    }
  }
  return records.map(({ actorDisplay: _ignored, ...record }) => {
    let rawName: string | null | undefined;
    if (record.actor.kind === "user") {
      rawName = names.get(record.actor.id)?.name;
    }
    if (record.actor.kind === "guest") {
      rawName = guests.get(`${record.workspaceId}:${record.actor.id}`);
    }
    if (record.actor.kind === "peer") {
      rawName = peers.get(`${record.workspaceId}:${record.actor.id}`);
    }
    const name = rawName?.trim().slice(0, 200);
    return name ? { ...record, actorDisplay: { name } } : record;
  });
};
