/**
 * The hourly limit of a connection. It counts what the connection did in the
 * last hour: tasks the peer sent us, tasks we sent the peer, and the wakes a
 * peer's answer started (an `a2a.result_received` event with `woke: true`). A
 * wake has no row of its own, so the event is what counts.
 */
import type { Database } from "@repo/db";
import { a2aOutboundTasks, a2aTasks } from "@repo/db/schema/a2a";
import { events } from "@repo/db/schema/events";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Clock } from "../runs/types.ts";

export const HOUR_MS = 60 * 60_000;

/**
 * The wake events of one connection since `since`. The time is the `at` in the
 * payload, written by the same clock the limit reads, not the event's own
 * stamp.
 */
const wakeAt = sql<string>`json_extract(${events.payload}, '$.at')`;
const wakeCondition = (connectionId: string, since: string) =>
  and(
    eq(events.type, "a2a.result_received"),
    sql`${wakeAt} > ${since}`,
    sql`json_extract(${events.payload}, '$.woke') = 1`,
    sql`json_extract(${events.payload}, '$.connectionId') = ${connectionId}`
  );

/**
 * A SQL expression for the number of tasks and wakes of a connection since
 * `since`, so an insert can check the limit in the same statement it writes.
 */
export const hourlyCountSql = (connectionId: string, since: string) =>
  sql`((select count(*) from ${a2aTasks} where ${a2aTasks.connectionId} = ${connectionId} and ${a2aTasks.createdAt} > ${since}) + (select count(*) from ${a2aOutboundTasks} where ${a2aOutboundTasks.connectionId} = ${connectionId} and ${a2aOutboundTasks.createdAt} > ${since}) + (select count(*) from ${events} where ${wakeCondition(connectionId, since)}))`;

/** Tasks and wakes in the last hour in both directions, and when the oldest one drops out. */
export const hourlyUse = async (
  db: Database,
  clock: Clock,
  connectionId: string
): Promise<{ oldest: string | null; used: number }> => {
  const since = new Date(clock.now().getTime() - HOUR_MS).toISOString();
  const [inbound, outbound, wakes] = await Promise.all([
    db
      .select({ at: a2aTasks.createdAt })
      .from(a2aTasks)
      .where(
        and(
          eq(a2aTasks.connectionId, connectionId),
          gt(a2aTasks.createdAt, since)
        )
      ),
    db
      .select({ at: a2aOutboundTasks.createdAt })
      .from(a2aOutboundTasks)
      .where(
        and(
          eq(a2aOutboundTasks.connectionId, connectionId),
          gt(a2aOutboundTasks.createdAt, since)
        )
      ),
    db
      .select({ at: wakeAt })
      .from(events)
      .where(wakeCondition(connectionId, since)),
  ]);
  const times = [...inbound, ...outbound, ...wakes].map(({ at }) => at).sort();
  return { oldest: times[0] ?? null, used: times.length };
};
