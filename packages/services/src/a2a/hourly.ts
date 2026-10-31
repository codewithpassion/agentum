/**
 * The hourly limit of a connection. It counts what the connection did in the
 * last hour: tasks the peer sent us, tasks we sent the peer, and the wakes a
 * peer's answer started. A wake has no row of its own, so it is counted on the
 * task it woke: the claim that lets a wake happen writes `result_read_at` as
 * the time followed by `WAKE_MARK`, and an agent's own read writes the plain
 * time. Count and claim are one statement, so wakes cannot overrun the limit.
 */
import type { Database } from "@repo/db";
import { a2aOutboundTasks, a2aTasks } from "@repo/db/schema/a2a";
import { and, eq, gt, like, sql } from "drizzle-orm";
import type { Clock } from "../runs/types.ts";

export const HOUR_MS = 60 * 60_000;

/** Ends a `result_read_at` that a wake claimed. */
export const WAKE_MARK = "#wake";

/** Characters in an ISO time such as `2026-11-01T10:00:00.000Z`. */
const ISO_LENGTH = 24;

const wakeTime = sql<string>`substr(${a2aOutboundTasks.resultReadAt}, 1, ${ISO_LENGTH})`;

const wakeClaimed = (connectionId: string, since: string) =>
  and(
    eq(a2aOutboundTasks.connectionId, connectionId),
    like(a2aOutboundTasks.resultReadAt, `%${WAKE_MARK}`),
    sql`${wakeTime} > ${since}`
  );

/**
 * A SQL expression for the number of tasks and wakes of a connection since
 * `since`, so an insert or a claim can check the limit in the same statement
 * that writes.
 */
export const hourlyCountSql = (connectionId: string, since: string) =>
  sql`((select count(*) from ${a2aTasks} where ${a2aTasks.connectionId} = ${connectionId} and ${a2aTasks.createdAt} > ${since}) + (select count(*) from ${a2aOutboundTasks} where ${a2aOutboundTasks.connectionId} = ${connectionId} and ${a2aOutboundTasks.createdAt} > ${since}) + (select count(*) from ${a2aOutboundTasks} where ${wakeClaimed(connectionId, since)}))`;

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
      .select({ at: wakeTime })
      .from(a2aOutboundTasks)
      .where(wakeClaimed(connectionId, since)),
  ]);
  const times = [...inbound, ...outbound, ...wakes].map(({ at }) => at).sort();
  return { oldest: times[0] ?? null, used: times.length };
};
