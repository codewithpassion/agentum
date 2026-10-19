/**
 * Network log for agent requests, made by the `web_fetch` tool and by `curl`.
 * Each request writes one `network.request` event with the host, method,
 * status, size and time. Only the host name is written. No path, query,
 * header or body reaches the log, so it cannot leak what a request carried.
 */
import type { Database } from "@repo/db";
import { runs } from "@repo/db/schema/runs";
import { and, eq } from "drizzle-orm";
import type { EventsService } from "./events.ts";

export interface NetworkRequestEntry {
  /** Why the request was refused, when it was. Then `status` is null. */
  blocked?: string;
  /** Size of the answer body in bytes, 0 when refused. */
  bytes: number;
  durationMs: number;
  /** Host name only: no scheme, port, path or query. */
  host: string;
  method: string;
  status: number | null;
  via: "curl" | "run_script" | "web_fetch";
}

const KB = 1024;
const MB = 1024 * KB;

/** Bytes as the Log shows them: B, then KB and MB with one decimal. */
const formatBytes = (bytes: number): string => {
  if (bytes < KB) {
    return `${bytes} B`;
  }
  // Round in tenths first, so a value that would print as "1024.0 KB" moves to MB.
  if (Math.round((bytes / KB) * 10) < 10 * KB) {
    return `${(bytes / KB).toFixed(1)} KB`;
  }
  return `${(bytes / MB).toFixed(1)} MB`;
};

/** The one line the Log shows for a request. */
const describe = (entry: NetworkRequestEntry): string => {
  const target = `${entry.method} ${entry.host}`;
  if (entry.blocked !== undefined) {
    return `${target} refused: ${entry.blocked}`;
  }
  const status = entry.status ?? "no response";
  return `${target} ${status}, ${formatBytes(entry.bytes)}, ${Math.round(entry.durationMs)} ms`;
};

export const createNetworkService = ({
  db,
  events,
}: {
  db: Database;
  events: EventsService;
}) => {
  const sessionOf = async (
    workspaceId: string,
    runId: string
  ): Promise<string | null> => {
    const [run] = await db
      .select({ sessionId: runs.sessionId })
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.workspaceId, workspaceId)))
      .limit(1);
    return run?.sessionId ?? null;
  };

  /**
   * A run made a request through `web_fetch` or `curl`. The payload is built
   * field by field, so nothing else on `entry` can reach the log.
   */
  const recordRequest = async (
    run: { agentId: string; runId: string; workspaceId: string },
    entry: NetworkRequestEntry
  ): Promise<void> => {
    await events.append({
      actor: { id: run.agentId, kind: "agent" },
      agentId: run.agentId,
      payload: {
        bytes: entry.bytes,
        durationMs: entry.durationMs,
        host: entry.host,
        method: entry.method,
        status: entry.status,
        text: describe(entry),
        via: entry.via,
        ...(entry.blocked === undefined ? {} : { blocked: entry.blocked }),
      },
      runId: run.runId,
      sessionId: await sessionOf(run.workspaceId, run.runId),
      type: "network.request",
      workspaceId: run.workspaceId,
    });
  };

  return { recordRequest };
};

export type NetworkService = ReturnType<typeof createNetworkService>;
