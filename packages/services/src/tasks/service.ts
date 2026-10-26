/**
 * Tasks as the task view reads them. A task is one run: `get` returns it with
 * its agent, who started it, the session's other runs, the session's events
 * and the run's open request. `list` returns recent runs with a title and a
 * status band. A run is visible when its session is, so another member's ui
 * session or private Slack DM never shows. Writes happen in `runs`.
 */
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { machines } from "@repo/db/schema/machines";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { triggers } from "@repo/db/schema/triggers";
import type {
  AgentRuntime,
  EventType,
  RunStatus,
  StatusBand,
} from "@repo/db/shared";
import { and, asc, desc, eq, inArray, lt, ne, type SQL } from "drizzle-orm";
import { z } from "zod";
import { authorize, ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import { personLabel } from "../events/summary.ts";
import {
  EVENT_QUERY_MAX_LIMIT,
  type EventRecord,
  type EventsService,
  type PeopleLookup,
} from "../events.ts";
import type { RequestRecord, RequestsService } from "../requests.ts";
import { toRecord } from "../runs/records.ts";
import type { Clock, RunRecord } from "../runs/types.ts";
import {
  loadTitleSources,
  type SessionRow,
  titleFor,
  visibleSessions,
} from "../sessions.ts";
import type { Principal } from "../workspaces.ts";
import { inBatches, latestBandEvents } from "./reads.ts";
import { statusBand } from "./status-band.ts";

const READ_ACTION = "tasks.read";
const TASK_KIND = "task";

/** Most runs one `list` call returns. */
export const TASK_LIST_MAX = 100;

/** Events one `get` reads: three full pages. A longer session says so in `eventsTruncated`. */
const EVENTS_CAP = EVENT_QUERY_MAX_LIMIT * 3;

const id = z.string().min(1).max(200);

export const taskGetInputSchema = z.strictObject({ runId: id });
export type TaskGetInput = z.input<typeof taskGetInputSchema>;

export const taskListInputSchema = z.strictObject({
  agentId: id.optional(),
  /** Run id to page from: only runs older than it are returned. */
  before: id.optional(),
  limit: z.number().int().min(1).max(TASK_LIST_MAX),
});
export type TaskListInput = z.input<typeof taskListInputSchema>;

/** Who or what started a task, in words. */
export interface StartedBy {
  kind:
    | "person"
    | "slack"
    | "inbox"
    | "trigger"
    | "routine"
    | "handoff"
    | "system";
  label: string;
  /** For a handoff, the run that started this one. */
  parentRunId?: string;
}

export interface TaskListItem {
  agentId: string;
  createdAt: string;
  finishedAt: string | null;
  id: string;
  sessionId: string;
  status: RunStatus;
  statusBand: StatusBand;
  title: string;
}

export interface TaskView {
  agent: {
    id: string;
    machine: { id: string; name: string } | null;
    name: string;
    runtime: AgentRuntime;
  };
  /** The session's events of the types the stream carries, oldest first, from every run in it. */
  events: EventRecord[];
  /** True when the session has more events than `events` holds. */
  eventsTruncated: boolean;
  /** The other runs of the session, oldest first. */
  otherRuns: {
    createdAt: string;
    id: string;
    inputText: string;
    status: RunStatus;
  }[];
  /** The run's open request that has not expired, or null. */
  request: RequestRecord | null;
  run: {
    /** What the run cost so far. Null when the runtime reported none. */
    costUsd: number | null;
    createdAt: string;
    finishedAt: string | null;
    id: string;
    inputText: string;
    startedAt: string | null;
    status: RunStatus;
  };
  session: {
    externalKey: string | null;
    id: string;
    origin: string;
  };
  startedBy: StartedBy;
  title: string;
}

type UserPrincipal = Extract<Principal, { kind: "user" }>;

const queuedSchema = z.object({ origin: z.string() });

/** The origin a `run.queued` payload names, when it has one. */
const originOf = (payload: string | null): string | null => {
  if (payload === null) {
    return null;
  }
  const parsed = queuedSchema.safeParse(JSON.parse(payload));
  return parsed.success ? parsed.data.origin : null;
};

export const createTasksService = ({
  clock,
  db,
  eventTypes,
  events,
  people,
  requests,
}: {
  clock: Clock;
  db: Database;
  /** The event types a task view shows. The app passes the ones its session stream carries. */
  eventTypes: readonly EventType[];
  events: Pick<EventsService, "query">;
  people?: PeopleLookup;
  requests: Pick<RequestsService, "listPending">;
}) => {
  const requireMember = (principal: Principal): UserPrincipal => {
    if (principal.kind !== "user") {
      throw new ForbiddenError(READ_ACTION);
    }
    authorize(principal, READ_ACTION, {
      kind: TASK_KIND,
      workspaceId: principal.workspaceId,
    });
    return principal;
  };

  /** The open requests that have not expired, by run id. */
  const openRequests = async (
    member: UserPrincipal,
    sessionId?: string
  ): Promise<Map<string, RequestRecord[]>> => {
    const now = clock.now().toISOString();
    const byRun = new Map<string, RequestRecord[]>();
    const pending = await requests.listPending(member, { sessionId });
    for (const record of pending) {
      if (record.expiresAt > now) {
        byRun.set(record.runId, [...(byRun.get(record.runId) ?? []), record]);
      }
    }
    return byRun;
  };

  /** The name of a person, or null when there is no lookup or it fails. */
  const personName = async (userId: string): Promise<string | null> => {
    if (!people) {
      return null;
    }
    try {
      const found = await people([userId]);
      return personLabel(found.get(userId)) ?? null;
    } catch (error) {
      console.error("People lookup failed", error);
      return null;
    }
  };

  /** A run another run started: the parent's agent, by name. */
  const handoffOf = async (run: RunRecord, parentRunId: string) => {
    const [parent] = await db
      .select({ agentName: agents.name })
      .from(runs)
      .innerJoin(agents, eq(runs.agentId, agents.id))
      .where(
        and(eq(runs.id, parentRunId), eq(runs.workspaceId, run.workspaceId))
      )
      .limit(1);
    return {
      kind: "handoff",
      label: `Handoff from ${parent?.agentName ?? "another agent"}`,
      parentRunId,
    } satisfies StartedBy;
  };

  /** A run a trigger or routine started, by the trigger's name. */
  const triggerOf = async (run: RunRecord) => {
    const [trigger] = await db
      .select({ kind: triggers.kind, name: triggers.name })
      .from(triggers)
      .where(
        and(
          eq(triggers.id, run.actor.id),
          eq(triggers.workspaceId, run.workspaceId)
        )
      )
      .limit(1);
    const routine = trigger?.kind === "routine";
    const noun = routine ? "Routine" : "Trigger";
    return {
      kind: routine ? "routine" : "trigger",
      label: trigger ? `${noun}: ${trigger.name}` : noun,
    } satisfies StartedBy;
  };

  /**
   * Who started the run. A run another run started is a handoff. Otherwise its
   * origin decides for Slack and the inbox, and its actor for the rest.
   */
  const startedByOf = async (
    run: RunRecord,
    session: SessionRow
  ): Promise<StartedBy> => {
    if (run.parentRunId !== null) {
      return await handoffOf(run, run.parentRunId);
    }
    const [queued] = await db
      .select({ payload: eventRows.payload })
      .from(eventRows)
      .where(and(eq(eventRows.runId, run.id), eq(eventRows.type, "run.queued")))
      .limit(1);
    const origin = originOf(queued?.payload ?? null) ?? session.origin;
    if (origin === "slack") {
      return { kind: "slack", label: "Slack" };
    }
    if (origin === "inbox") {
      const sources = await loadTitleSources(db, [session]);
      const title = sources.threadTitles.get(session.externalKey ?? "");
      return {
        kind: "inbox",
        label: title ? `Inbox thread: ${title}` : "Inbox thread",
      };
    }
    if (run.actor.kind === "trigger") {
      return await triggerOf(run);
    }
    if (run.actor.kind === "user") {
      return {
        kind: "person",
        label: (await personName(run.actor.id)) ?? "A teammate",
      };
    }
    return { kind: "system", label: "System" };
  };

  /** The session's events, oldest first, up to `EVENTS_CAP`. */
  const sessionEvents = async (
    member: UserPrincipal,
    sessionId: string
  ): Promise<{ events: EventRecord[]; truncated: boolean }> => {
    const found: EventRecord[] = [];
    let after: string | undefined;
    const page = (limit: number) =>
      events.query(member, member.workspaceId, {
        after,
        limit,
        sessionId,
        types: [...eventTypes],
      });
    while (found.length < EVENTS_CAP) {
      // biome-ignore lint/performance/noAwaitInLoops: each page starts after the last one
      const batch = await page(EVENT_QUERY_MAX_LIMIT);
      found.push(...batch);
      if (batch.length < EVENT_QUERY_MAX_LIMIT) {
        return { events: found, truncated: false };
      }
      after = batch.at(-1)?.id;
    }
    return { events: found, truncated: (await page(1)).length > 0 };
  };

  const get = async (
    principal: Principal,
    rawInput: TaskGetInput
  ): Promise<TaskView> => {
    const member = requireMember(principal);
    const { runId } = taskGetInputSchema.parse(rawInput);
    const [row] = await db
      .select({
        agentName: agents.name,
        machineId: machines.id,
        machineName: machines.name,
        run: runs,
        runtime: agents.runtime,
        session: sessions,
      })
      .from(runs)
      .innerJoin(sessions, eq(runs.sessionId, sessions.id))
      .innerJoin(agents, eq(runs.agentId, agents.id))
      .leftJoin(machines, eq(sessions.runtimeMachineId, machines.id))
      .where(
        and(
          await visibleSessions(db, member),
          eq(runs.id, runId),
          eq(runs.workspaceId, member.workspaceId)
        )
      )
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Task not found");
    }
    const run = toRecord(row.run);
    const [otherRuns, startedBy, sources, session, open] = await Promise.all([
      db
        .select()
        .from(runs)
        .where(and(eq(runs.sessionId, run.sessionId), ne(runs.id, run.id)))
        .orderBy(asc(runs.id)),
      startedByOf(run, row.session),
      loadTitleSources(db, [row.session]),
      sessionEvents(member, run.sessionId),
      openRequests(member, run.sessionId),
    ]);
    return {
      agent: {
        id: run.agentId,
        machine:
          row.machineId === null
            ? null
            : { id: row.machineId, name: row.machineName ?? "" },
        name: row.agentName,
        runtime: row.runtime,
      },
      events: session.events,
      eventsTruncated: session.truncated,
      otherRuns: otherRuns.map((other) => ({
        createdAt: other.createdAt,
        id: other.id,
        inputText: other.inputText,
        status: other.status,
      })),
      request: open.get(run.id)?.[0] ?? null,
      run: {
        costUsd: run.usage?.costUsd ?? null,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        id: run.id,
        inputText: run.inputText,
        startedAt: run.startedAt,
        status: run.status,
      },
      session: {
        externalKey: row.session.externalKey,
        id: row.session.id,
        origin: row.session.origin,
      },
      startedBy,
      title: titleFor(sources, row.session, run.inputText),
    };
  };

  const list = async (
    principal: Principal,
    rawInput: TaskListInput
  ): Promise<TaskListItem[]> => {
    const member = requireMember(principal);
    const { agentId, before, limit } = taskListInputSchema.parse(rawInput);
    const conditions: (SQL | undefined)[] = [
      eq(runs.workspaceId, member.workspaceId),
      inArray(
        runs.sessionId,
        db
          .select({ id: sessions.id })
          .from(sessions)
          .where(await visibleSessions(db, member))
      ),
      agentId === undefined ? undefined : eq(runs.agentId, agentId),
      before === undefined ? undefined : lt(runs.id, before),
    ];
    const rows = await db
      .select()
      .from(runs)
      .where(and(...conditions))
      .orderBy(desc(runs.id))
      .limit(limit);
    if (rows.length === 0) {
      return [];
    }
    const sessionRows = await inBatches(
      rows.map((run) => run.sessionId),
      (batch) => db.select().from(sessions).where(inArray(sessions.id, batch))
    );
    const [sources, latest, open] = await Promise.all([
      loadTitleSources(db, sessionRows),
      latestBandEvents(
        db,
        rows.filter((run) => run.status === "running").map((run) => run.id)
      ),
      rows.some((run) => run.status === "waiting")
        ? openRequests(member)
        : new Map<string, RequestRecord[]>(),
    ]);
    const sessionOf = new Map(sessionRows.map((row) => [row.id, row]));
    return rows.map((run) => {
      const session = sessionOf.get(run.sessionId);
      return {
        agentId: run.agentId,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        id: run.id,
        sessionId: run.sessionId,
        status: run.status,
        statusBand: statusBand(
          run,
          latest.get(run.id) ?? [],
          open.get(run.id) ?? []
        ),
        title: session ? titleFor(sources, session, run.inputText) : "",
      };
    });
  };

  return { get, list };
};

export type TasksService = ReturnType<typeof createTasksService>;
