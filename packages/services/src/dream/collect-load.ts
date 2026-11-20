import type { Database } from "@repo/db";
import { events as eventRows } from "@repo/db/schema/events";
import { memoryChanges } from "@repo/db/schema/memory";
import { runRequests } from "@repo/db/schema/requests";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { skillVersions } from "@repo/db/schema/skills";
import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export type Session = typeof sessions.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunRequest = typeof runRequests.$inferSelect;
export type MemoryChange = typeof memoryChanges.$inferSelect;
type EventRow = typeof eventRows.$inferSelect;
type SkillVersion = typeof skillVersions.$inferSelect;

/** The rows that changed inside the window, before their context is read. */
export interface Window {
  changes: MemoryChange[];
  finishedRuns: Run[];
  messageRows: EventRow[];
  rejected: { event: EventRow; version: SkillVersion }[];
  windowRequests: RunRequest[];
}

/** The runs, requests and sessions the window's rows point at. */
export interface Context {
  requestById: Map<string, RunRequest>;
  runById: Map<string, Run>;
  sessionById: Map<string, Session>;
}

export interface Scope {
  agentId: string;
  /** ISO 8601 UTC, exclusive. Null reads the agent's whole history. */
  floor: string | null;
  workspaceId: string;
}

// D1 allows 100 bound parameters per statement.
const IN_CHUNK = 80;

const readByIds = async <T>(
  ids: Iterable<string>,
  read: (chunk: string[]) => Promise<T[]>
): Promise<T[]> => {
  const all = [...new Set(ids)];
  const out: T[] = [];
  for (let start = 0; start < all.length; start += IN_CHUNK) {
    // biome-ignore lint/performance/noAwaitInLoops: chunks of a bounded id list
    out.push(...(await read(all.slice(start, start + IN_CHUNK))));
  }
  return out;
};

/**
 * Only rows that changed inside the window are read, so a dream costs what the
 * window holds, not the agent's whole history. Every read is scoped to the
 * workspace and the agent.
 */
export const readWindow = async (
  db: Database,
  { agentId, floor, workspaceId }: Scope
): Promise<Window> => {
  const after = (column: AnySQLiteColumn) =>
    floor === null ? undefined : gt(column, floor);
  const requestSince =
    floor === null
      ? undefined
      : sql`coalesce(${runRequests.answeredAt}, ${runRequests.createdAt}) > ${floor}`;
  const changeSince =
    floor === null
      ? undefined
      : or(
          gt(memoryChanges.createdAt, floor),
          gt(memoryChanges.decidedAt, floor)
        );
  const [messageRows, finishedRuns, windowRequests, changes, rejected] =
    await Promise.all([
      db
        .select()
        .from(eventRows)
        .where(
          and(
            eq(eventRows.workspaceId, workspaceId),
            eq(eventRows.agentId, agentId),
            inArray(eventRows.type, ["message.user", "message.assistant"]),
            after(eventRows.createdAt)
          )
        ),
      db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.workspaceId, workspaceId),
            eq(runs.agentId, agentId),
            after(runs.finishedAt)
          )
        ),
      db
        .select()
        .from(runRequests)
        .where(
          and(
            eq(runRequests.workspaceId, workspaceId),
            eq(runRequests.agentId, agentId),
            requestSince
          )
        ),
      db
        .select()
        .from(memoryChanges)
        .where(
          and(
            eq(memoryChanges.workspaceId, workspaceId),
            eq(memoryChanges.agentId, agentId),
            changeSince
          )
        ),
      // Human rejection events may have no agentId. Attribute them by the
      // version's author, including proposals to shared/another agent's skills.
      // EventsService.query cannot express this join. The event supplies the
      // rejection time; version.createdAt is the proposal time, not the decision.
      db
        .select({ event: eventRows, version: skillVersions })
        .from(skillVersions)
        .innerJoin(
          eventRows,
          and(
            eq(eventRows.workspaceId, workspaceId),
            eq(eventRows.type, "skill.rejected"),
            sql`json_extract(${eventRows.payload}, '$.skillId') = ${skillVersions.skillId}`,
            sql`json_extract(${eventRows.payload}, '$.version') = ${skillVersions.number}`,
            after(eventRows.createdAt)
          )
        )
        .where(
          and(
            eq(skillVersions.workspaceId, workspaceId),
            eq(skillVersions.authorKind, "agent"),
            eq(skillVersions.authorId, agentId),
            eq(skillVersions.status, "rejected")
          )
        ),
    ]);
  return { changes, finishedRuns, messageRows, rejected, windowRequests };
};

const sourceRequestIdsOf = (changes: MemoryChange[]) =>
  changes.flatMap((change) =>
    change.sourceKind === "request" && change.sourceId ? [change.sourceId] : []
  );

const runIdsOf = (window: Window, requests: Iterable<RunRequest>) => {
  const ids = new Set<string>();
  for (const event of window.messageRows) {
    if (event.runId) {
      ids.add(event.runId);
    }
  }
  for (const request of requests) {
    ids.add(request.runId);
  }
  for (const change of window.changes) {
    if (change.sourceKind === "run" && change.sourceId) {
      ids.add(change.sourceId);
    }
  }
  for (const { version } of window.rejected) {
    if (version.authorRunId) {
      ids.add(version.authorRunId);
    }
  }
  return ids;
};

const sessionIdsOf = (
  window: Window,
  requests: Iterable<RunRequest>,
  runList: Iterable<Run>
) => {
  const ids = new Set<string>();
  for (const event of window.messageRows) {
    if (event.sessionId) {
      ids.add(event.sessionId);
    }
  }
  for (const change of window.changes) {
    if (change.sourceKind === "session" && change.sourceId) {
      ids.add(change.sourceId);
    }
  }
  for (const request of requests) {
    ids.add(request.sessionId);
  }
  for (const run of runList) {
    ids.add(run.sessionId);
  }
  return ids;
};

/**
 * Reads what the window's rows point at: the requests, runs and sessions that
 * tag them, and the cancelled runs a resend follows. A run or session of
 * another agent is never read, so a cross-agent link finds nothing.
 */
export const loadContext = async (
  db: Database,
  { agentId, workspaceId }: Scope,
  window: Window
): Promise<Context> => {
  const requestById = new Map(window.windowRequests.map((r) => [r.id, r]));
  const sourceRequests = await readByIds(
    sourceRequestIdsOf(window.changes).filter((id) => !requestById.has(id)),
    (ids) =>
      db
        .select()
        .from(runRequests)
        .where(
          and(
            eq(runRequests.workspaceId, workspaceId),
            eq(runRequests.agentId, agentId),
            inArray(runRequests.id, ids)
          )
        )
  );
  for (const request of sourceRequests) {
    requestById.set(request.id, request);
  }
  const runById = new Map(window.finishedRuns.map((r) => [r.id, r]));
  const linkedRuns = await readByIds(
    [...runIdsOf(window, requestById.values())].filter(
      (id) => !runById.has(id)
    ),
    (ids) =>
      db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.workspaceId, workspaceId),
            eq(runs.agentId, agentId),
            inArray(runs.id, ids)
          )
        )
  );
  for (const run of linkedRuns) {
    runById.set(run.id, run);
  }
  const sessionIds = sessionIdsOf(
    window,
    requestById.values(),
    runById.values()
  );
  const cancelled = await readByIds(sessionIds, (ids) =>
    db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, workspaceId),
          eq(runs.agentId, agentId),
          eq(runs.status, "cancelled"),
          inArray(runs.sessionId, ids)
        )
      )
  );
  for (const run of cancelled) {
    runById.set(run.id, run);
  }
  const sessionRows = await readByIds(sessionIds, (ids) =>
    db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, workspaceId),
          eq(sessions.agentId, agentId),
          inArray(sessions.id, ids)
        )
      )
  );
  return {
    requestById,
    runById,
    sessionById: new Map(sessionRows.map((s) => [s.id, s])),
  };
};
