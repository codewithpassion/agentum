/**
 * Tasks as the task view reads them. A task is one run: `get` returns it with
 * its agent, who started it, the session's other runs, the session's events
 * and the run's open request. `list` returns recent runs with a title and a
 * status band. A run is visible when its session is, so another member's ui
 * session or private Slack DM never shows. Writes happen in `runs`.
 */
import type { Database } from "@repo/db";
import { a2aConnections } from "@repo/db/schema/a2a";
import { agents } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { machines } from "@repo/db/schema/machines";
import { mailMessages } from "@repo/db/schema/mail";
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
import {
  createTaskFiles,
  type TaskFiles,
  type TaskFilesInput,
  taskFilesInputSchema,
} from "../library/task-files.ts";
import { mailSubjectsOf } from "../mail-subjects.ts";
import type { RequestRecord, RequestsService } from "../requests.ts";
import { toRecord } from "../runs/records.ts";
import type { Clock, RunRecord } from "../runs/types.ts";
import {
  loadTitleSources,
  runTitleFor,
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

/** A run, or a session: the session's latest run. */
export const taskGetInputSchema = z.union([
  z.strictObject({ runId: id }),
  z.strictObject({ sessionId: id }),
]);
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
    | "mail"
    | "inbox"
    | "trigger"
    | "routine"
    | "handoff"
    | "peer"
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
    /** The computer the agent is attached to, or null. Not the machine the session runs on. */
    computerMachineId: string | null;
    id: string;
    machine: { id: string; name: string } | null;
    name: string;
    runtime: AgentRuntime;
  };
  /** Threads that hand-offs and helpers of this thread started, oldest first. Only those the caller may see. */
  children: {
    agentName: string;
    id: string;
    status: RunStatus;
    title: string;
  }[];
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
    title: string;
  }[];
  /** The thread this one was started from, when the caller may see it. */
  parent: { id: string; title: string } | null;
  /** The run's open request that has not expired, or null. */
  request: RequestRecord | null;
  run: {
    /** What the run cost so far. Null when the runtime reported none. */
    costUsd: number | null;
    createdAt: string;
    finishedAt: string | null;
    id: string;
    inputText: string;
    model?: string;
    startedAt: string | null;
    status: RunStatus;
  };
  session: {
    archivedAt: string | null;
    externalKey: string | null;
    id: string;
    origin: string;
    parentSessionId: string | null;
    pinnedAt: string | null;
    /** The name the person gave the thread, else the title its first run gives it. */
    title: string;
  };
  startedBy: StartedBy;
  /** Child runs started as subagents, visible under the same session rules. */
  subagents?: { id: string; model: string; status: RunStatus; title: string }[];
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
  /** The event types a task view shows. The app passes the stream's types plus the connector outcomes. */
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
      label:
        run.subagentLevel > 0
          ? `Subagent of ${parent?.agentName ?? "another agent"}`
          : `Handoff from ${parent?.agentName ?? "another agent"}`,
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

  /** A run an outside agent started: its connection's label, never anything it sent. */
  const peerOf = async (run: RunRecord): Promise<StartedBy> => {
    const [connection] = await db
      .select({ label: a2aConnections.peerLabel })
      .from(a2aConnections)
      .where(
        and(
          eq(a2aConnections.id, run.actor.id),
          eq(a2aConnections.workspaceId, run.workspaceId)
        )
      )
      .limit(1);
    return {
      kind: "peer",
      label: `${connection?.label?.trim() || "An outside agent"} (outside agent)`,
    };
  };

  const mailStarter = async (run: RunRecord): Promise<StartedBy> => {
    const [mail] = await db
      .select()
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.runId, run.id),
          eq(mailMessages.direction, "in"),
          eq(mailMessages.workspaceId, run.workspaceId)
        )
      )
      .limit(1);
    let sender = "unknown sender";
    try {
      const from = JSON.parse(mail?.fromAddress ?? "null") as {
        address?: string;
      } | null;
      sender = from?.address ?? sender;
    } catch {
      /* Older malformed address rows keep a readable fallback. */
    }
    return {
      kind: "mail",
      label: `Mail from ${sender}: ${mail?.subject ?? "(no subject)"}`,
    };
  };

  /** Who started a run that no origin explains: its actor. */
  const actorStarter = async (run: RunRecord): Promise<StartedBy> => {
    if (run.actor.kind === "trigger") {
      return await triggerOf(run);
    }
    if (run.actor.kind === "peer") {
      return await peerOf(run);
    }
    if (run.actor.kind === "user") {
      return {
        kind: "person",
        label: (await personName(run.actor.id)) ?? "A teammate",
      };
    }
    return { kind: "system", label: "System" };
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
    if (origin === "mail") {
      return await mailStarter(run);
    }
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
    return await actorStarter(run);
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

  /** The newest run of a session the member can see. */
  const latestRunOf = async (
    member: UserPrincipal,
    sessionId: string
  ): Promise<string> => {
    const [latest] = await db
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(sessions, eq(runs.sessionId, sessions.id))
      .where(
        and(
          await visibleSessions(db, member),
          eq(runs.sessionId, sessionId),
          eq(runs.workspaceId, member.workspaceId)
        )
      )
      .orderBy(desc(runs.id))
      .limit(1);
    if (!latest) {
      throw new ServiceError("not_found", "Task not found");
    }
    return latest.id;
  };

  /** The title and the latest run status of each session, in two batched reads. */
  const titlesAndStatuses = async (rows: SessionRow[]) => {
    const [sources, sessionRuns] = await Promise.all([
      loadTitleSources(db, rows),
      inBatches(
        rows.map((row) => row.id),
        (batch) =>
          db
            .select({
              id: runs.id,
              inputText: runs.inputText,
              sessionId: runs.sessionId,
              status: runs.status,
            })
            .from(runs)
            .where(inArray(runs.sessionId, batch))
            .orderBy(asc(runs.id))
      ),
    ]);
    const first = new Map<string, string>();
    const latest = new Map<string, RunStatus>();
    for (const sessionRun of sessionRuns) {
      if (!first.has(sessionRun.sessionId)) {
        first.set(sessionRun.sessionId, sessionRun.inputText);
      }
      latest.set(sessionRun.sessionId, sessionRun.status);
    }
    return new Map(
      rows.map((row) => [
        row.id,
        {
          status: latest.get(row.id) ?? ("queued" as RunStatus),
          title:
            row.title !== null && row.title.trim() !== ""
              ? row.title
              : titleFor(sources, row, first.get(row.id) ?? ""),
        },
      ])
    );
  };

  /** A thread's parent and child threads, those the caller may see. */
  const relativesOf = async (
    member: UserPrincipal,
    session: SessionRow
  ): Promise<Pick<TaskView, "children" | "parent">> => {
    const visible = await visibleSessions(db, member);
    const [parentRows, childRows] = await Promise.all([
      session.parentSessionId === null
        ? []
        : db
            .select()
            .from(sessions)
            .where(and(eq(sessions.id, session.parentSessionId), visible)),
      db
        .select({ agentName: agents.name, session: sessions })
        .from(sessions)
        .innerJoin(agents, eq(sessions.agentId, agents.id))
        .where(and(eq(sessions.parentSessionId, session.id), visible))
        .orderBy(asc(sessions.createdAt), asc(sessions.id)),
    ]);
    const known = await titlesAndStatuses([
      ...parentRows,
      ...childRows.map((child) => child.session),
    ]);
    const [parent] = parentRows;
    return {
      children: childRows.map((child) => ({
        agentName: child.agentName,
        id: child.session.id,
        status: known.get(child.session.id)?.status ?? "queued",
        title: known.get(child.session.id)?.title ?? "",
      })),
      parent: parent
        ? { id: parent.id, title: known.get(parent.id)?.title ?? "" }
        : null,
    };
  };

  const get = async (
    principal: Principal,
    rawInput: TaskGetInput
  ): Promise<TaskView> => {
    const member = requireMember(principal);
    const input = taskGetInputSchema.parse(rawInput);
    const runId =
      "runId" in input
        ? input.runId
        : await latestRunOf(member, input.sessionId);
    const [row] = await db
      .select({
        agentModel: agents.model,
        agentName: agents.name,
        computerMachineId: agents.computerMachineId,
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
    const subagents = await db
      .select({
        id: runs.id,
        inputText: runs.inputText,
        model: runs.model,
        status: runs.status,
      })
      .from(runs)
      .innerJoin(sessions, eq(runs.sessionId, sessions.id))
      .where(
        and(
          eq(runs.parentRunId, run.id),
          eq(runs.workspaceId, member.workspaceId),
          ne(runs.subagentLevel, 0),
          await visibleSessions(db, member)
        )
      )
      .orderBy(asc(runs.id));
    const relatives = await relativesOf(member, row.session);
    const subjects = await mailSubjectsOf(db, member.workspaceId, [
      run.id,
      ...otherRuns.map((other) => other.id),
    ]);
    const first = [row.run, ...otherRuns].reduce((a, b) =>
      a.id < b.id ? a : b
    );
    return {
      agent: {
        computerMachineId: row.computerMachineId,
        id: run.agentId,
        machine:
          row.machineId === null
            ? null
            : { id: row.machineId, name: row.machineName ?? "" },
        name: row.agentName,
        runtime: row.runtime,
      },
      children: relatives.children,
      events: session.events,
      eventsTruncated: session.truncated,
      otherRuns: otherRuns.map((other) => ({
        createdAt: other.createdAt,
        id: other.id,
        inputText: other.inputText,
        status: other.status,
        title: runTitleFor(other.inputText, subjects.get(other.id)),
      })),
      parent: relatives.parent,
      request: open.get(run.id)?.[0] ?? null,
      run: {
        costUsd: run.usage?.costUsd ?? null,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        id: run.id,
        inputText: run.inputText,
        model: run.model ?? row.agentModel,
        startedAt: run.startedAt,
        status: run.status,
      },
      session: {
        archivedAt: row.session.archivedAt,
        externalKey: row.session.externalKey,
        id: row.session.id,
        origin: row.session.origin,
        parentSessionId: row.session.parentSessionId,
        pinnedAt: row.session.pinnedAt,
        title:
          row.session.title !== null && row.session.title.trim() !== ""
            ? row.session.title
            : titleFor(
                sources,
                row.session,
                first.inputText,
                subjects.get(first.id)
              ),
      },
      startedBy,
      subagents: subagents.map((child) => ({
        id: child.id,
        model: child.model ?? row.agentModel,
        status: child.status,
        title: runTitleFor(child.inputText),
      })),
      title: titleFor(
        sources,
        row.session,
        run.inputText,
        subjects.get(run.id)
      ),
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
      eq(runs.dryRun, false),
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
    const [sources, latest, open, subjects] = await Promise.all([
      loadTitleSources(db, sessionRows),
      latestBandEvents(
        db,
        rows.filter((run) => run.status === "running").map((run) => run.id)
      ),
      rows.some((run) => run.status === "waiting")
        ? openRequests(member)
        : new Map<string, RequestRecord[]>(),
      mailSubjectsOf(
        db,
        member.workspaceId,
        rows.map((run) => run.id)
      ),
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
        title: session
          ? titleFor(sources, session, run.inputText, subjects.get(run.id))
          : "",
      };
    });
  };

  const { taskFiles } = createTaskFiles({ db });

  /** The files a task left in the library: its folder, edits outside it, and its open conflicts. */
  const files = (
    principal: Principal,
    rawInput: TaskFilesInput
  ): Promise<TaskFiles> =>
    taskFiles(principal, taskFilesInputSchema.parse(rawInput).runId);

  return { files, get, list };
};

export type TasksService = ReturnType<typeof createTasksService>;
