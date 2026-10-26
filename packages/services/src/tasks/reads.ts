import type { Database } from "@repo/db";
import { events } from "@repo/db/schema/events";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { type EventRecord, toRecord } from "../events.ts";

/** Ids per `IN (...)` read, under D1's limit of 100 bound parameters. */
const BATCH = 50;

/** The latest `tool.call` or `message.assistant` is all `statusBand` reads from the events. */
const BAND_EVENT_TYPES = ["tool.call", "message.assistant"];

/** Reads `ids` in batches small enough for one `IN (...)` each. */
export const inBatches = async <T>(
  ids: readonly string[],
  read: (batch: string[]) => Promise<T[]>
): Promise<T[]> => {
  const unique = [...new Set(ids)];
  const batches: string[][] = [];
  for (let start = 0; start < unique.length; start += BATCH) {
    batches.push(unique.slice(start, start + BATCH));
  }
  return (await Promise.all(batches.map(read))).flat();
};

/**
 * The newest `tool.call` or `message.assistant` of each run, one read
 * through `events_run_idx`. Only a running run's band reads events.
 */
export const latestBandEvents = async (
  db: Database,
  runIds: readonly string[]
): Promise<Map<string, EventRecord[]>> => {
  const rank = sql<number>`row_number() over (partition by ${events.runId} order by ${events.id} desc)`;
  const found = await inBatches(runIds, (batch) => {
    const ranked = db
      .select({ ...getTableColumns(events), rank: rank.as("rank") })
      .from(events)
      .where(
        and(
          inArray(events.runId, batch),
          inArray(events.type, BAND_EVENT_TYPES)
        )
      )
      .as("ranked");
    return db.select().from(ranked).where(eq(ranked.rank, 1));
  });
  const byRun = new Map<string, EventRecord[]>();
  for (const row of found) {
    if (row.runId) {
      byRun.set(row.runId, [toRecord(row)]);
    }
  }
  return byRun;
};
