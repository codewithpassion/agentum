/**
 * Inbound A2A tasks: a peer's message becomes a task, the inbound policy
 * decides whether it waits for a person or starts a run, and the run's events
 * move the task. The spec is docs/v3/agent-connections.md ("A2A mapping",
 * "What the agent sees", "Policies on a connection").
 *
 * No HTTP happens here. The `/a2a` routes (AA.4) authenticate a peer with
 * `connections.authenticate`, call these methods with that `peer` principal,
 * and map `A2aTaskError`, `A2aRateLimitError` and `ServiceError`. A peer reads
 * and changes only the tasks of its own connection, and another connection's
 * task is `TaskNotFoundError`, the same as one that does not exist.
 *
 * The task row is the truth the client sees. It moves only through `move`, a
 * compare-and-set on the state it expects, so a run event, the minute sweep, a
 * person and the peer can race without a terminal state ever reverting, and a
 * state change queues its push rows once.
 */

import {
  type SendMessageRequest,
  sendMessageRequestSchema,
} from "@repo/a2a/requests";
import { taskStateSchema } from "@repo/a2a/states";
import type { Task } from "@repo/a2a/tasks";
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import {
  a2aAgentCards,
  a2aAnswerMarkers,
  a2aConnections,
  a2aOutbox,
  a2aTasks,
} from "@repo/db/schema/a2a";
import { agents } from "@repo/db/schema/agents";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import type {
  A2aTaskState,
  EventActorKind,
  EventType,
  RunStatus,
} from "@repo/db/shared";
import { LIVE_RUN_STATUS_LITERALS, LIVE_RUN_STATUSES } from "@repo/db/shared";
import { questionDisplaySchema } from "@repo/protocol/requests";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "../authz.ts";
import { isUniqueViolation, ServiceError } from "../errors.ts";
import type { EventRecord, EventsService } from "../events.ts";
import { requireSession } from "../guards.ts";
import type { RequestsService } from "../requests.ts";
import { MAX_RUN_DEPTH } from "../runs/subject.ts";
import {
  type Clock,
  type Gateway,
  INPUT_TEXT_MAX,
  type StartRunInput,
  type StartRunOptions,
} from "../runs/types.ts";
import { hostOf, idString } from "../shared.ts";
import { buildPeerEnvelope } from "../speaker-envelope.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { requireReader } from "./access.ts";
import type { PeerPrincipal } from "./connections.ts";
import { A2aRateLimitError, A2aTaskError } from "./errors.ts";
import { HOUR_MS, hourlyCountSql, hourlyUse } from "./hourly.ts";
import type { WaitingMessage } from "./needs-you.ts";
import {
  createPushConfigs,
  type OutboxInsert,
  type PushConfigInput,
  type PushConfigView,
} from "./push-configs.ts";
import {
  hopsOf,
  questionStatusText,
  RUNNING,
  STATUS_TEXT,
  type TaskRow,
  TERMINAL,
  textOfParts,
  toTask,
} from "./task-view.ts";

export const TASK_KIND = "a2a_task";
export const SEND_ACTION = "a2a.message";
export const READ_ACTION = "a2a.task.read";
export const CANCEL_ACTION = "a2a.task.cancel";
export const APPROVE_ACTION = "a2a.message.approve";
export const DECLINE_ACTION = "a2a.message.decline";
export const PUSH_ACTION = "a2a.push";

const MINUTE_MS = 60_000;
const MS_PER_SECOND = 1000;
/** A task that stayed `SUBMITTED` this long with no run never will get one. */
const NEVER_STARTED_AFTER_MS = 5 * MINUTE_MS;
/**
 * Tasks the minute sweep looks at in one go. Below D1's cap of 100 bound
 * parameters, for the one update that stamps a batch.
 */
const SWEEP_BATCH = 50;
const SWEEP_CONNECTIONS = 20;
/** Rounds of cancelling in one revoke. A run a cancelled run started in the meantime is caught by the next, and the sweep finishes the rest. */
const REVOKE_ROUNDS = 5;
const WAITING_LIST_CAP = 200;
const MESSAGE_ID_MAX = 200;
const CONTEXT_ID_MAX = 100;
/** Peer text longer than this is refused. The envelope adds some more. */
export const MESSAGE_TEXT_MAX = 30_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const UNKNOWN_HOST = "unknown host";

/** Run statuses that never change again. */
const ENDED_RUN_STATUSES: RunStatus[] = [
  "done",
  "failed",
  "interrupted",
  "cancelled",
];

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const SYSTEM_ACTOR = { id: "tick", kind: "system" } as const;

const historyLengthSchema = z.number().int().min(0).optional();

export const getTaskInputSchema = z.object({
  historyLength: historyLengthSchema,
  id: idString,
});
export type GetTaskInput = z.input<typeof getTaskInputSchema>;

export const cancelTaskInputSchema = z.object({ id: idString });
export type CancelTaskInput = z.input<typeof cancelTaskInputSchema>;

export const listTasksInputSchema = z.object({
  contextId: z.string().min(1).max(CONTEXT_ID_MAX).optional(),
  historyLength: historyLengthSchema,
  includeArtifacts: z.boolean().optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  pageToken: z.string().max(500).optional(),
  status: taskStateSchema.optional(),
  statusTimestampAfter: z.iso.datetime().optional(),
});
export type ListTasksInput = z.input<typeof listTasksInputSchema>;

export interface ListTasksResult {
  nextPageToken: string;
  pageSize: number;
  tasks: Task[];
  totalSize: number;
}

const pushTaskInputSchema = z.object({ taskId: idString });
const pushConfigRefSchema = pushTaskInputSchema.extend({ id: idString });

export interface A2aTasksOptions {
  /** Dev builds only: a push webhook may be on localhost over plain http. */
  allowLoopback?: boolean;
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: EventsService;
  /**
   * Called after a state change has queued push notifications, so the app can
   * deliver them at once. The minute tick delivers whatever this did not.
   */
  onPushQueued?: () => void;
  requests: Pick<RequestsService, "answerAsPeer">;
  runs: {
    cancelRun: (principal: Principal, runId: string) => Promise<void>;
    startRun: (
      principal: Principal,
      input: StartRunInput,
      options?: StartRunOptions
    ) => Promise<{ runId: string }>;
  };
  /** `SECRETS_KEY`. Storing a push credential encrypts with it. */
  secretsKey?: string;
}

type ConnectionRow = typeof a2aConnections.$inferSelect;

/**
 * The query behind `liveRunsReaching`. Its live statuses are literals that
 * repeat the condition of the partial index `runs_live_status_idx`, so the
 * unscoped walk starts from that index and reads only the live runs, not all
 * of `runs`. Bound parameters would not let SQLite use the index.
 */
export const liveRunsReachingSql = (
  scope: { connectionId: string; workspaceId: string } | null,
  limit: number
) => sql`
  with recursive up(live_id, parent_id, actor_kind, actor_id, hops) as (
    select r.id, r.parent_run_id, r.actor_kind, r.actor_id, 0
    from ${runRows} as r
    where r.status in (${sql.raw(LIVE_RUN_STATUS_LITERALS)})
      ${scope ? sql`and r.workspace_id = ${scope.workspaceId}` : sql``}
    union all
    select u.live_id, p.parent_run_id, p.actor_kind, p.actor_id, u.hops + 1
    from up as u
    join ${runRows} as p on p.id = u.parent_id
    where u.hops <= ${MAX_RUN_DEPTH}
  )
  select distinct live_id as id from up
  where actor_kind = 'peer'
    and ${
      scope
        ? sql`actor_id = ${scope.connectionId}`
        : sql`actor_id in (select id from ${a2aConnections} where status in ('declined', 'revoked'))`
    }
  limit ${limit}
`;

/** What `move` writes besides the new state. */
interface Patch {
  decidedBy?: string;
  resultText?: string | null;
  statusText: string | null;
}

const eventPayload = (
  row: { connectionId: string; id: string },
  extra: Record<string, string | number | boolean | null> = {}
) => ({ connectionId: row.connectionId, taskId: row.id, ...extra });

export const createA2aTasksService = ({
  allowLoopback,
  atomic,
  clock,
  db,
  events,
  onPushQueued,
  requests,
  runs,
  secretsKey,
}: A2aTasksOptions) => {
  const pushConfigs = createPushConfigs({
    allowLoopback,
    clock,
    db,
    secretsKey,
  });
  const nowIso = () => clock.now().toISOString();

  // ---------------------------------------------------------------------
  // Lookups and events

  const record = async (input: {
    actor: { id: string; kind: EventActorKind };
    agentId: string;
    payload: Record<string, string | number | boolean | null>;
    type: EventType;
    workspaceId: string;
  }): Promise<void> => {
    await events.append(input);
  };

  const peerActor = (connection: Pick<ConnectionRow, "id">) =>
    ({ id: connection.id, kind: "peer" }) as const;

  const requireConnection = async (
    peer: PeerPrincipal,
    action: string
  ): Promise<ConnectionRow> => {
    const [row] = await db
      .select()
      .from(a2aConnections)
      .where(
        and(
          eq(a2aConnections.id, peer.connectionId),
          eq(a2aConnections.workspaceId, peer.workspaceId)
        )
      )
      .limit(1);
    if (row?.status !== "active" || row.localAgentId !== peer.agentId) {
      throw new ForbiddenError(action);
    }
    return row;
  };

  const peerFor = (
    connection: Pick<ConnectionRow, "id" | "localAgentId" | "workspaceId">
  ): PeerPrincipal => ({
    agentId: connection.localAgentId,
    connectionId: connection.id,
    kind: "peer",
    workspaceId: connection.workspaceId,
  });

  const connectionById = async (
    id: string,
    workspaceId: string
  ): Promise<ConnectionRow | null> => {
    const [row] = await db
      .select()
      .from(a2aConnections)
      .where(
        and(
          eq(a2aConnections.id, id),
          eq(a2aConnections.workspaceId, workspaceId)
        )
      )
      .limit(1);
    return row ?? null;
  };

  const taskNotFound = () =>
    new A2aTaskError("TaskNotFoundError", "Task not found");

  /** A task of this connection, or `TaskNotFoundError`. */
  const requireTask = async (
    connection: Pick<ConnectionRow, "id" | "workspaceId">,
    taskId: string
  ): Promise<TaskRow> => {
    const [row] = await db
      .select()
      .from(a2aTasks)
      .where(
        and(
          eq(a2aTasks.id, taskId),
          eq(a2aTasks.connectionId, connection.id),
          eq(a2aTasks.workspaceId, connection.workspaceId)
        )
      )
      .limit(1);
    if (!row) {
      throw taskNotFound();
    }
    return row;
  };

  const taskById = async (id: string): Promise<TaskRow | null> => {
    const [row] = await db
      .select()
      .from(a2aTasks)
      .where(eq(a2aTasks.id, id))
      .limit(1);
    return row ?? null;
  };

  // ---------------------------------------------------------------------
  // State

  /**
   * The push rows of a state change are written in the same atomic write as the
   * change, and only while the task carries the token of that change's own
   * update, so a caller that lost the race queues nothing.
   */
  const pushWhileMoved = (
    row: OutboxInsert,
    moved: { id: string; token: string }
  ) =>
    db.insert(a2aOutbox).select(
      db
        .select({
          attempts: sql<number>`${row.attempts}`.as("attempts"),
          body: sql<string>`${row.body}`.as("body"),
          connectionId: sql<string>`${row.connectionId}`.as("connectionId"),
          createdAt: sql<string>`${row.createdAt}`.as("createdAt"),
          headers: sql<string | null>`${row.headers ?? null}`.as("headers"),
          id: sql<string>`${row.id}`.as("id"),
          kind: sql<string>`${row.kind}`.as("kind"),
          nextAttemptAt: sql<string>`${row.nextAttemptAt}`.as("nextAttemptAt"),
          url: sql<string>`${row.url}`.as("url"),
          workspaceId: sql<string>`${row.workspaceId}`.as("workspaceId"),
        })
        .from(sql`(select 1)`)
        .where(
          sql`exists (select 1 from ${a2aTasks} where ${a2aTasks.id} = ${moved.id} and ${a2aTasks.moveToken} = ${moved.token})`
        )
    );

  /**
   * Moves a task from one of the states `from` to `to` and queues its pushes
   * with it, in one atomic write. The database decides who wins: the update
   * matches only a task still in one of the states `from` (and, for a decision
   * by a person, one that nobody has decided), and writes a token no other call
   * has. The caller whose token is on the row afterwards moved the task and
   * alone queued its pushes. Null for a task that was not in any of the states
   * `from`, and for a caller that lost the race, which may be another process.
   */
  const move = async (
    id: string,
    from: readonly A2aTaskState[],
    to: A2aTaskState,
    patch: Patch
  ): Promise<TaskRow | null> => {
    const current = await taskById(id);
    if (
      !(current && from.includes(current.state)) ||
      (current.state === to && current.statusText === patch.statusText)
    ) {
      return null;
    }
    const at = nowIso();
    const token = ulid();
    const changes = {
      ...(patch.decidedBy === undefined
        ? {}
        : { decidedAt: at, decidedBy: patch.decidedBy }),
      moveToken: token,
      ...(patch.resultText === undefined
        ? {}
        : { resultText: patch.resultText }),
      state: to,
      statusText: patch.statusText,
      updatedAt: at,
    };
    let pushes: OutboxInsert[] = [];
    try {
      pushes = await pushConfigs.rowsFor({ ...current, ...changes });
    } catch (error) {
      // A push that cannot be built must not hold the task's state back.
      console.error("A2A push not built", id, error);
    }
    await atomic([
      db
        .update(a2aTasks)
        .set(changes)
        .where(
          and(
            eq(a2aTasks.id, id),
            inArray(a2aTasks.state, [...from]),
            patch.decidedBy === undefined
              ? undefined
              : isNull(a2aTasks.decidedAt)
          )
        ),
      ...pushes.map((row) => pushWhileMoved(row, { id, token })),
    ]);
    const after = await taskById(id);
    if (after?.moveToken !== token) {
      return null;
    }
    if (pushes.length > 0) {
      onPushQueued?.();
    }
    return after;
  };

  const fresh = async (id: string): Promise<TaskRow> => {
    const row = await taskById(id);
    if (!row) {
      throw taskNotFound();
    }
    return row;
  };

  // ---------------------------------------------------------------------
  // Sending

  const refuse = async (
    connection: ConnectionRow,
    reason: string,
    extra: Record<string, string | number | boolean | null> = {}
  ): Promise<void> => {
    await record({
      actor: peerActor(connection),
      agentId: connection.localAgentId,
      payload: { connectionId: connection.id, reason, ...extra },
      type: "a2a.message_refused",
      workspaceId: connection.workspaceId,
    });
  };

  const enforceHourlyLimit = async (connection: ConnectionRow) => {
    const { oldest, used } = await hourlyUse(db, clock, connection.id);
    if (used < connection.hourlyLimit) {
      return;
    }
    const freeAt =
      (oldest ? Date.parse(oldest) : clock.now().getTime()) + HOUR_MS;
    const retryAfterSeconds = Math.max(
      Math.ceil((freeAt - clock.now().getTime()) / MS_PER_SECOND),
      1
    );
    await record({
      actor: peerActor(connection),
      agentId: connection.localAgentId,
      payload: {
        connectionId: connection.id,
        limit: connection.hourlyLimit,
        retryAfterSeconds,
      },
      type: "a2a.rate_limited",
      workspaceId: connection.workspaceId,
    });
    throw new A2aRateLimitError(retryAfterSeconds);
  };

  const requireGateableAgent = async (connection: ConnectionRow) => {
    const [agent] = await db
      .select({
        published: a2aAgentCards.agentId,
        runtime: agents.runtime,
        status: agents.status,
        unpublishedAt: a2aAgentCards.unpublishedAt,
      })
      .from(agents)
      .leftJoin(a2aAgentCards, eq(a2aAgentCards.agentId, agents.id))
      .where(
        and(
          eq(agents.id, connection.localAgentId),
          eq(agents.workspaceId, connection.workspaceId)
        )
      )
      .limit(1);
    if (agent?.status !== "active") {
      throw new ServiceError("not_found", "Agent not found");
    }
    if (agent.published === null || agent.unpublishedAt !== null) {
      throw new ServiceError("conflict", "The agent is no longer published");
    }
    if (agent.runtime === "managed") {
      throw new A2aTaskError(
        "UnsupportedOperationError",
        "This agent cannot take messages from peers."
      );
    }
  };

  /** The peer's text as the run's input: wrapped in the envelope that says who sent it. */
  const envelopeOf = (connection: ConnectionRow, text: string): string =>
    buildPeerEnvelope(
      {
        agentName: connection.peerLabel ?? "",
        connectionId: connection.id,
        host: hostOf(connection.peerOrigin) ?? UNKNOWN_HOST,
      },
      text
    );

  /**
   * Starts the run of a task and links it, in one atomic write with the run
   * itself. A run that cannot start fails the task and says so to nobody but the
   * log: the peer reads a failed task, never the reason. A task that was
   * cancelled or revoked while the run was being made has the run cancelled
   * too.
   */
  const startRunFor = async (
    connection: ConnectionRow,
    task: TaskRow
  ): Promise<void> => {
    const peer: PeerPrincipal = { ...peerFor(connection), hops: task.hops };
    let started: { runId: string };
    try {
      started = await runs.startRun(
        peer,
        {
          agentId: connection.localAgentId,
          input: { text: envelopeOf(connection, task.inputText) },
          reply: { kind: "a2a", taskId: task.id },
          session: {
            externalKey: `${connection.id}:${task.contextId}`,
            origin: "a2a",
          },
        },
        {
          alongside: ({ runId }) => [
            db.update(a2aTasks).set({ runId }).where(eq(a2aTasks.id, task.id)),
          ],
        }
      );
    } catch (error) {
      console.error("A2A run not started", task.id, error);
      await move(task.id, ["TASK_STATE_SUBMITTED"], "TASK_STATE_FAILED", {
        statusText: STATUS_TEXT.notStarted,
      });
      // The run may have been written before the offer to its runtime failed.
      const linked = await taskById(task.id);
      if (linked?.runId) {
        await cancelRunQuietly(linked.runId);
      }
      return;
    }
    const after = await taskById(task.id);
    if (after && TERMINAL.includes(after.state)) {
      await cancelRunQuietly(started.runId);
    }
  };

  const validateMessage = (request: SendMessageRequest) => {
    const { message } = request;
    if (message.role !== "ROLE_USER") {
      throw new ServiceError(
        "invalid",
        "A message to an agent has role ROLE_USER"
      );
    }
    if (
      message.messageId.length > MESSAGE_ID_MAX ||
      (message.contextId?.length ?? 0) > CONTEXT_ID_MAX
    ) {
      throw new ServiceError(
        "invalid",
        "A message id or context id is too long"
      );
    }
    if (message.contextId === "" || message.taskId === "") {
      throw new ServiceError("invalid", "A context id or task id is empty");
    }
    const text = textOfParts(message.parts);
    if (text.trim() === "") {
      throw new ServiceError("invalid", "The message has no text");
    }
    if (text.length > MESSAGE_TEXT_MAX) {
      throw new ServiceError(
        "invalid",
        `The message is over ${MESSAGE_TEXT_MAX} characters`
      );
    }
    return text;
  };

  /** The questions a run has open, the one asked first first. */
  const pendingQuestions = async (runId: string, limit: number) =>
    await db
      .select({ display: runRequests.display, id: runRequests.id })
      .from(runRequests)
      .where(
        and(
          eq(runRequests.runId, runId),
          eq(runRequests.kind, "question"),
          eq(runRequests.status, "pending")
        )
      )
      .orderBy(asc(runRequests.createdAt), asc(runRequests.id))
      .limit(limit);

  /**
   * Answers the question for a peer. The marker goes in first and the answer
   * second. A retry finds the marker and answers nothing, and false says so. If
   * this request dies in between, the question stays open for the peer's next
   * message, which is the safe way to fail. A refused answer takes its marker
   * back.
   */
  const giveAnswer = async (
    peer: PeerPrincipal,
    connection: ConnectionRow,
    input: {
      messageId: string;
      question: { id: string };
      task: TaskRow;
      text: string;
    }
  ): Promise<boolean> => {
    const { messageId, question, task, text } = input;
    if (!(await claimAnswer(connection, task, messageId, question.id))) {
      return false;
    }
    let closed = false;
    try {
      await requests.answerAsPeer(peer, { requestId: question.id, text });
    } catch (error) {
      // Only an answer that did not land gives its marker back. One that
      // committed and failed afterwards (the wake of the run, say) keeps it, so
      // the peer's retry cannot answer the next question.
      if (await questionStillOpen(question.id)) {
        await releaseAnswer(connection, messageId);
      }
      // Someone answered it a moment ago.
      if (!(error instanceof ServiceError && error.code === "conflict")) {
        throw error;
      }
      closed = true;
    }
    if (closed) {
      throw new A2aTaskError(
        "UnsupportedOperationError",
        "The task is not waiting for an answer."
      );
    }
    return true;
  };

  /** The next message on a task: an answer to the question it asks, or nothing. */
  const continueTask = async (
    peer: PeerPrincipal,
    connection: ConnectionRow,
    request: SendMessageRequest,
    text: string
  ): Promise<TaskRow> => {
    const { message } = request;
    const task = await requireTask(connection, message.taskId ?? "");
    if (
      message.contextId !== undefined &&
      message.contextId !== task.contextId
    ) {
      throw new ServiceError(
        "invalid",
        "The contextId does not match the task's context"
      );
    }
    if (TERMINAL.includes(task.state)) {
      throw new A2aTaskError(
        "UnsupportedOperationError",
        "The task has ended. Send a new message without a taskId to start another."
      );
    }
    // The task's status shows the question asked first, so that is the one answered.
    const [question] =
      task.state === "TASK_STATE_INPUT_REQUIRED" && task.runId
        ? await pendingQuestions(task.runId, 1)
        : [];
    if (!question) {
      throw new A2aTaskError(
        "UnsupportedOperationError",
        "The task is not waiting for an answer."
      );
    }
    if (
      !(await giveAnswer(peer, connection, {
        messageId: message.messageId,
        question,
        task,
        text,
      }))
    ) {
      return task;
    }
    await db
      .update(a2aConnections)
      .set({ lastInAt: nowIso() })
      .where(eq(a2aConnections.id, connection.id));
    await record({
      actor: peerActor(connection),
      agentId: connection.localAgentId,
      payload: eventPayload(task, {
        answer: true,
        chars: text.length,
        messageId: message.messageId,
      }),
      type: "a2a.message_received",
      workspaceId: connection.workspaceId,
    });
    // Back to working, or on to the next question the run has open.
    await settleQuestion(await fresh(task.id));
    return await fresh(task.id);
  };

  const byMessageId = async (
    connectionId: string,
    messageId: string
  ): Promise<TaskRow | null> => {
    const [row] = await db
      .select()
      .from(a2aTasks)
      .where(
        and(
          eq(a2aTasks.connectionId, connectionId),
          eq(a2aTasks.messageId, messageId)
        )
      )
      .limit(1);
    return row ?? null;
  };

  /** Everything a new task must pass before a row is written. Returns the hops it claims. */
  const admit = async (
    peer: PeerPrincipal,
    connection: ConnectionRow,
    request: SendMessageRequest,
    text: string
  ): Promise<number> => {
    const { message } = request;
    const hops = Math.max(
      peer.hops ?? 0,
      hopsOf(message.metadata, request.metadata)
    );
    if (hops > MAX_RUN_DEPTH) {
      await refuse(connection, "hops", { hops });
      throw new ServiceError(
        "invalid",
        `This message has passed through more than ${MAX_RUN_DEPTH} agents, so it is refused to stop a loop.`
      );
    }
    if (envelopeOf(connection, text).length > INPUT_TEXT_MAX) {
      throw new ServiceError("invalid", "The message is too long");
    }
    await requireGateableAgent(connection);
    await enforceHourlyLimit(connection);
    if (request.configuration?.taskPushNotificationConfig) {
      pushConfigs.validate(request.configuration.taskPushNotificationConfig);
    }
    return hops;
  };

  /**
   * The insert of a task that only lands while the connection is under its
   * hourly limit, counted in the same statement, so two sends at once cannot
   * both take the last place.
   */
  const insertUnderLimit = (
    row: typeof a2aTasks.$inferInsert,
    connection: ConnectionRow
  ) => {
    const since = new Date(clock.now().getTime() - HOUR_MS).toISOString();
    return db
      .insert(a2aTasks)
      .select(
        db
          .select({
            connectionId: sql<string>`${row.connectionId}`.as("connectionId"),
            contextId: sql<string>`${row.contextId}`.as("contextId"),
            createdAt: sql<string>`${row.createdAt}`.as("createdAt"),
            decidedAt: sql<string | null>`${null}`.as("decidedAt"),
            decidedBy: sql<string | null>`${null}`.as("decidedBy"),
            hops: sql<number>`${row.hops}`.as("hops"),
            id: sql<string>`${row.id}`.as("id"),
            inputText: sql<string>`${row.inputText}`.as("inputText"),
            messageId: sql<string>`${row.messageId}`.as("messageId"),
            moveToken: sql<string | null>`${null}`.as("moveToken"),
            resultText: sql<string | null>`${null}`.as("resultText"),
            runId: sql<string | null>`${null}`.as("runId"),
            state: sql<string>`${row.state}`.as("state"),
            statusText: sql<string | null>`${row.statusText ?? null}`.as(
              "statusText"
            ),
            sweptAt: sql<string | null>`${null}`.as("sweptAt"),
            updatedAt: sql<string>`${row.updatedAt}`.as("updatedAt"),
            workspaceId: sql<string>`${row.workspaceId}`.as("workspaceId"),
          })
          .from(sql`(select 1)`)
          .where(
            sql`exists (select 1 from ${a2aConnections} where ${a2aConnections.id} = ${connection.id} and ${a2aConnections.status} = 'active') and ${hourlyCountSql(connection.id, since)} < ${connection.hourlyLimit}`
          )
      )
      .returning({ id: a2aTasks.id });
  };

  /**
   * Writes the task, or returns the one an earlier send of the same `messageId`
   * made. Refuses with the rate limit when the connection has no place left.
   */
  const insertOrRecall = async (
    row: typeof a2aTasks.$inferInsert,
    connection: ConnectionRow
  ): Promise<TaskRow | null> => {
    let inserted: { id: string }[] = [];
    let duplicate = false;
    try {
      inserted = await insertUnderLimit(row, connection);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      duplicate = true;
    }
    if (duplicate) {
      const winner = await byMessageId(connection.id, row.messageId);
      if (winner) {
        return winner;
      }
      throw new ServiceError("conflict", "That message id is already used");
    }
    if (inserted.length === 0) {
      // The same message made the task a moment ago, or the connection ended
      // or filled up while this send was checked.
      const winner = await byMessageId(connection.id, row.messageId);
      if (winner) {
        return winner;
      }
      await requireConnection(
        { ...peerFor(connection), hops: row.hops },
        SEND_ACTION
      );
      await enforceHourlyLimit(connection);
      throw new A2aRateLimitError(1);
    }
    return null;
  };

  /**
   * A message that opens a new task: `approve` leaves it waiting for a person,
   * `auto` starts the run at once. A repeated `messageId` returns the task the
   * first one made.
   */
  const openTask = async (
    peer: PeerPrincipal,
    connection: ConnectionRow,
    request: SendMessageRequest,
    text: string
  ): Promise<TaskRow> => {
    const { message } = request;
    const hops = await admit(peer, connection, request, text);
    const waits = connection.inboundPolicy === "approve";
    const at = nowIso();
    const row = {
      connectionId: connection.id,
      contextId: message.contextId ?? ulid(clock.now().getTime()),
      createdAt: at,
      hops,
      id: `tsk_${ulid(clock.now().getTime())}`,
      inputText: text,
      messageId: message.messageId,
      state: waits ? "TASK_STATE_AUTH_REQUIRED" : "TASK_STATE_SUBMITTED",
      statusText: waits ? STATUS_TEXT.approvalWaiting : STATUS_TEXT.queued,
      updatedAt: at,
      workspaceId: connection.workspaceId,
    } satisfies typeof a2aTasks.$inferInsert;
    const recalled = await insertOrRecall(row, connection);
    if (recalled) {
      return recalled;
    }
    await db
      .update(a2aConnections)
      .set({ lastInAt: at })
      .where(eq(a2aConnections.id, connection.id));
    await record({
      actor: peerActor(connection),
      agentId: connection.localAgentId,
      payload: eventPayload(row, {
        chars: text.length,
        hops,
        messageId: message.messageId,
        policy: connection.inboundPolicy,
      }),
      type: "a2a.message_received",
      workspaceId: connection.workspaceId,
    });
    const push = request.configuration?.taskPushNotificationConfig;
    if (push) {
      await pushConfigs.create(row, push);
    }
    if (!waits) {
      await startRunFor(connection, await fresh(row.id));
    }
    return await fresh(row.id);
  };

  /**
   * Records that this message is answering `requestId`, while the connection is
   * under its hourly limit, counted in the same statement so two answers at
   * once cannot both take the last place. False when the message was recorded
   * before, which means this is a retry. Past the limit it throws and writes
   * nothing, so the question stays open.
   */
  const claimAnswer = async (
    connection: ConnectionRow,
    task: TaskRow,
    messageId: string,
    requestId: string
  ): Promise<boolean> => {
    const since = new Date(clock.now().getTime() - HOUR_MS).toISOString();
    const marker = {
      connectionId: connection.id,
      createdAt: nowIso(),
      id: `ans_${ulid(clock.now().getTime())}`,
      messageId,
      requestId,
      taskId: task.id,
      workspaceId: connection.workspaceId,
    };
    const [claimed] = await db
      .insert(a2aAnswerMarkers)
      .select(
        db
          .select({
            connectionId: sql<string>`${marker.connectionId}`.as(
              "connectionId"
            ),
            createdAt: sql<string>`${marker.createdAt}`.as("createdAt"),
            id: sql<string>`${marker.id}`.as("id"),
            messageId: sql<string>`${marker.messageId}`.as("messageId"),
            requestId: sql<string>`${marker.requestId}`.as("requestId"),
            taskId: sql<string>`${marker.taskId}`.as("taskId"),
            workspaceId: sql<string>`${marker.workspaceId}`.as("workspaceId"),
          })
          .from(sql`(select 1)`)
          .where(
            sql`${hourlyCountSql(connection.id, since)} < ${connection.hourlyLimit}`
          )
      )
      .onConflictDoNothing()
      .returning({ id: a2aAnswerMarkers.id });
    if (claimed) {
      return true;
    }
    // A retry of an answer recorded a moment ago, or the connection is full.
    if ((await markedTask(connection, messageId)) !== null) {
      return false;
    }
    await enforceHourlyLimit(connection);
    throw new A2aRateLimitError(1);
  };

  const questionStillOpen = async (requestId: string): Promise<boolean> => {
    const [row] = await db
      .select({ status: runRequests.status })
      .from(runRequests)
      .where(eq(runRequests.id, requestId))
      .limit(1);
    return row?.status === "pending";
  };

  /** Takes a marker back when the answer it announced was refused, so the peer may try again. */
  const releaseAnswer = async (
    connection: ConnectionRow,
    messageId: string
  ): Promise<void> => {
    await db
      .delete(a2aAnswerMarkers)
      .where(
        and(
          eq(a2aAnswerMarkers.connectionId, connection.id),
          eq(a2aAnswerMarkers.messageId, messageId)
        )
      );
  };

  /** The task a message already answered on, or null when it has answered nothing. */
  const markedTask = async (
    connection: ConnectionRow,
    messageId: string
  ): Promise<string | null> => {
    const [marker] = await db
      .select({ taskId: a2aAnswerMarkers.taskId })
      .from(a2aAnswerMarkers)
      .where(
        and(
          eq(a2aAnswerMarkers.connectionId, connection.id),
          eq(a2aAnswerMarkers.messageId, messageId)
        )
      )
      .limit(1);
    return marker?.taskId ?? null;
  };

  /**
   * A peer's `SendMessage`. Returns the task as it stands: waiting for a
   * person, or queued. Blocking until it settles is the route's job.
   */
  const sendMessage = async (
    peer: PeerPrincipal,
    raw: SendMessageRequest
  ): Promise<Task> => {
    const request = sendMessageRequestSchema.parse(raw);
    const connection = await requireConnection(peer, SEND_ACTION);
    authorize(peer, SEND_ACTION, {
      kind: TASK_KIND,
      workspaceId: connection.workspaceId,
    });
    const { message } = request;
    const historyLength = request.configuration?.historyLength;
    const text = validateMessage(request);
    // A retry returns the first task before any policy or limit is looked at.
    const existing =
      message.taskId === undefined
        ? await byMessageId(connection.id, message.messageId)
        : null;
    if (existing) {
      return toTask(existing, historyLength);
    }
    // So does a retried answer, which must not answer the next question too.
    const marked = await markedTask(connection, message.messageId);
    if (marked !== null) {
      if (message.taskId !== undefined && marked !== message.taskId) {
        throw new ServiceError("invalid", "That message id is already used");
      }
      return toTask(await requireTask(connection, marked), historyLength);
    }
    if (connection.inboundPolicy === "off") {
      await refuse(connection, "inbound_off");
      throw new A2aTaskError(
        "UnsupportedOperationError",
        "This agent is not taking messages from this connection."
      );
    }
    const task =
      message.taskId === undefined
        ? await openTask(peer, connection, request, text)
        : await continueTask(peer, connection, request, text);
    return toTask(task, historyLength);
  };

  // ---------------------------------------------------------------------
  // Deciding

  const waitingTask = async (
    taskId: string,
    workspaceId: string
  ): Promise<{ connection: ConnectionRow; task: TaskRow }> => {
    const [task] = await db
      .select()
      .from(a2aTasks)
      .where(
        and(eq(a2aTasks.id, taskId), eq(a2aTasks.workspaceId, workspaceId))
      )
      .limit(1);
    const connection = task
      ? await connectionById(task.connectionId, workspaceId)
      : null;
    if (!(task && connection)) {
      throw new ServiceError("not_found", "Message not found");
    }
    return { connection, task };
  };

  /**
   * Any member on a session approves a waiting message. Only a message still
   * waiting can be approved, by one person, once. It starts the run now.
   */
  const approveTask = async (
    principal: Principal,
    taskId: string
  ): Promise<Task> => {
    const user = requireSession(principal, APPROVE_ACTION);
    authorize(user, APPROVE_ACTION, {
      id: taskId,
      kind: TASK_KIND,
      workspaceId: user.workspaceId,
    });
    const { connection, task } = await waitingTask(taskId, user.workspaceId);
    if (connection.status !== "active") {
      throw new ServiceError("conflict", "The connection is not active");
    }
    if (connection.inboundPolicy === "off") {
      throw new ServiceError(
        "conflict",
        "This connection is not taking messages right now"
      );
    }
    await requireGateableAgent(connection);
    const moved = await move(
      task.id,
      ["TASK_STATE_AUTH_REQUIRED"],
      "TASK_STATE_SUBMITTED",
      { decidedBy: user.userId, statusText: STATUS_TEXT.queued }
    );
    if (!moved) {
      throw new ServiceError(
        "conflict",
        "Someone already decided this message"
      );
    }
    await record({
      actor: { id: user.userId, kind: "user" },
      agentId: connection.localAgentId,
      payload: eventPayload(moved),
      type: "a2a.message_approved",
      workspaceId: connection.workspaceId,
    });
    await startRunFor(connection, moved);
    return toTask(await fresh(task.id));
  };

  const declineTask = async (
    principal: Principal,
    taskId: string
  ): Promise<Task> => {
    const user = requireSession(principal, DECLINE_ACTION);
    authorize(user, DECLINE_ACTION, {
      id: taskId,
      kind: TASK_KIND,
      workspaceId: user.workspaceId,
    });
    const { connection, task } = await waitingTask(taskId, user.workspaceId);
    const moved = await move(
      task.id,
      ["TASK_STATE_AUTH_REQUIRED"],
      "TASK_STATE_REJECTED",
      { decidedBy: user.userId, statusText: STATUS_TEXT.declined }
    );
    if (!moved) {
      throw new ServiceError(
        "conflict",
        "Someone already decided this message"
      );
    }
    await record({
      actor: { id: user.userId, kind: "user" },
      agentId: connection.localAgentId,
      payload: eventPayload(moved),
      type: "a2a.message_declined",
      workspaceId: connection.workspaceId,
    });
    return toTask(moved);
  };

  /** The messages waiting for a person, oldest first, for Needs you. */
  const listWaiting = async (
    principal: Principal
  ): Promise<WaitingMessage[]> => {
    const reader = requireReader(principal, READ_ACTION);
    authorize(reader, READ_ACTION, {
      kind: TASK_KIND,
      workspaceId: reader.workspaceId,
    });
    const rows = await db
      .select({
        agentId: a2aConnections.localAgentId,
        connectionId: a2aConnections.id,
        createdAt: a2aTasks.createdAt,
        org: a2aConnections.peerOrg,
        origin: a2aConnections.peerOrigin,
        peer: a2aConnections.peerLabel,
        taskId: a2aTasks.id,
        text: a2aTasks.inputText,
      })
      .from(a2aTasks)
      .innerJoin(a2aConnections, eq(a2aConnections.id, a2aTasks.connectionId))
      .where(
        and(
          eq(a2aTasks.workspaceId, reader.workspaceId),
          eq(a2aTasks.state, "TASK_STATE_AUTH_REQUIRED"),
          eq(a2aConnections.status, "active")
        )
      )
      .orderBy(asc(a2aTasks.createdAt), asc(a2aTasks.id))
      .limit(WAITING_LIST_CAP);
    return rows.map(({ origin, peer, ...row }) => ({
      ...row,
      host: hostOf(origin),
      peer: peer ?? "An outside agent",
    }));
  };

  // ---------------------------------------------------------------------
  // Reading and cancelling, scoped to the calling connection

  const getTask = async (
    peer: PeerPrincipal,
    raw: GetTaskInput
  ): Promise<Task> => {
    const input = getTaskInputSchema.parse(raw);
    const connection = await requireConnection(peer, READ_ACTION);
    authorize(peer, READ_ACTION, {
      id: input.id,
      kind: TASK_KIND,
      workspaceId: connection.workspaceId,
    });
    return toTask(await requireTask(connection, input.id), input.historyLength);
  };

  const encodeToken = (row: Pick<TaskRow, "id" | "updatedAt">): string =>
    btoa(`${row.updatedAt}|${row.id}`);

  const decodeToken = (token: string): { at: string; id: string } => {
    try {
      const [at, id] = atob(token).split("|");
      if (at && id) {
        return { at, id };
      }
    } catch {
      // Falls through to the refusal below.
    }
    throw new ServiceError("invalid", "The page token is not valid");
  };

  const listTasks = async (
    peer: PeerPrincipal,
    raw: ListTasksInput = {}
  ): Promise<ListTasksResult> => {
    const input = listTasksInputSchema.parse(raw);
    const connection = await requireConnection(peer, READ_ACTION);
    authorize(peer, READ_ACTION, {
      kind: TASK_KIND,
      workspaceId: connection.workspaceId,
    });
    const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
    const scope = and(
      eq(a2aTasks.connectionId, connection.id),
      input.contextId === undefined
        ? undefined
        : eq(a2aTasks.contextId, input.contextId),
      input.status === undefined ? undefined : eq(a2aTasks.state, input.status),
      input.statusTimestampAfter === undefined
        ? undefined
        : gt(
            a2aTasks.updatedAt,
            new Date(input.statusTimestampAfter).toISOString()
          )
    );
    const after = input.pageToken ? decodeToken(input.pageToken) : null;
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(a2aTasks)
        .where(
          and(
            scope,
            after
              ? or(
                  lt(a2aTasks.updatedAt, after.at),
                  and(
                    eq(a2aTasks.updatedAt, after.at),
                    lt(a2aTasks.id, after.id)
                  )
                )
              : undefined
          )
        )
        .orderBy(desc(a2aTasks.updatedAt), desc(a2aTasks.id))
        .limit(pageSize + 1),
      db.select({ n: count() }).from(a2aTasks).where(scope),
    ]);
    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    return {
      nextPageToken: rows.length > pageSize && last ? encodeToken(last) : "",
      pageSize,
      tasks: page.map((row) => {
        const task = toTask(row, input.historyLength ?? 0);
        if (input.includeArtifacts === true) {
          return task;
        }
        const { artifacts: _kept, ...withoutArtifacts } = task;
        return withoutArtifacts;
      }),
      totalSize: total?.n ?? 0,
    };
  };

  /**
   * Cancels a task of the caller's connection: a message still waiting is
   * cancelled where it stands, and a running one has its run cancelled. A task
   * that has ended is `TaskNotCancelableError`.
   */
  const cancelTask = async (
    peer: PeerPrincipal,
    raw: CancelTaskInput
  ): Promise<Task> => {
    const input = cancelTaskInputSchema.parse(raw);
    const connection = await requireConnection(peer, CANCEL_ACTION);
    authorize(peer, CANCEL_ACTION, {
      id: input.id,
      kind: TASK_KIND,
      workspaceId: connection.workspaceId,
    });
    const task = await requireTask(connection, input.id);
    if (TERMINAL.includes(task.state)) {
      throw new A2aTaskError(
        "TaskNotCancelableError",
        "The task has already ended."
      );
    }
    // The task goes first, so the run's own cancelled event finds it ended.
    const moved = await move(
      task.id,
      ["TASK_STATE_AUTH_REQUIRED", ...RUNNING],
      "TASK_STATE_CANCELED",
      { statusText: STATUS_TEXT.cancelledByPeer }
    );
    if (!moved) {
      throw new A2aTaskError(
        "TaskNotCancelableError",
        "The task has already ended."
      );
    }
    const runId = (await taskById(task.id))?.runId ?? task.runId;
    if (runId) {
      await cancelRunQuietly(runId);
    }
    await record({
      actor: peerActor(connection),
      agentId: connection.localAgentId,
      payload: eventPayload(moved, { reason: "peer" }),
      type: "a2a.task_cancelled",
      workspaceId: connection.workspaceId,
    });
    return toTask(moved);
  };

  const cancelRunQuietly = async (runId: string): Promise<void> => {
    try {
      await runs.cancelRun(SYSTEM_PRINCIPAL, runId);
    } catch (error) {
      // A run that ended in the meantime is already as cancelled as it gets.
      if (!(error instanceof ServiceError && error.code === "conflict")) {
        console.error("A2A run not cancelled", runId, error);
      }
    }
  };

  // ---------------------------------------------------------------------
  // Push configurations

  const requirePushTask = async (peer: PeerPrincipal, taskId: string) => {
    const connection = await requireConnection(peer, PUSH_ACTION);
    authorize(peer, PUSH_ACTION, {
      id: taskId,
      kind: TASK_KIND,
      workspaceId: connection.workspaceId,
    });
    return await requireTask(connection, taskId);
  };

  const createPushConfig = async (
    peer: PeerPrincipal,
    raw: { config: PushConfigInput; taskId: string }
  ): Promise<PushConfigView> => {
    const input = pushTaskInputSchema.parse({ taskId: raw.taskId });
    const task = await requirePushTask(peer, input.taskId);
    return await pushConfigs.create(task, raw.config);
  };

  const getPushConfig = async (
    peer: PeerPrincipal,
    raw: { id: string; taskId: string }
  ): Promise<PushConfigView> => {
    const input = pushConfigRefSchema.parse(raw);
    const task = await requirePushTask(peer, input.taskId);
    return await pushConfigs.get(task.id, input.id);
  };

  const listPushConfigs = async (
    peer: PeerPrincipal,
    raw: { taskId: string }
  ): Promise<PushConfigView[]> => {
    const input = pushTaskInputSchema.parse(raw);
    const task = await requirePushTask(peer, input.taskId);
    return await pushConfigs.list(task.id);
  };

  const deletePushConfig = async (
    peer: PeerPrincipal,
    raw: { id: string; taskId: string }
  ): Promise<void> => {
    const input = pushConfigRefSchema.parse(raw);
    const task = await requirePushTask(peer, input.taskId);
    await pushConfigs.remove(task.id, input.id);
  };

  // ---------------------------------------------------------------------
  // The run's side

  const complete = async (
    taskId: string,
    resultText: string
  ): Promise<TaskRow | null> =>
    await move(taskId, RUNNING, "TASK_STATE_COMPLETED", {
      resultText,
      statusText: null,
    });

  /**
   * The gateway the runs service hands a finished run's reply to. It stores the
   * result on the task. The `run.finished` event usually moves the task first,
   * and then this finds it already complete.
   */
  const gateway: Gateway = {
    deliver: async (target, message) => {
      if (target.kind === "a2a") {
        await complete(target.taskId, message.text);
      }
    },
    kind: "a2a",
  };

  const taskOfRun = async (runId: string): Promise<TaskRow | null> => {
    const [row] = await db
      .select()
      .from(a2aTasks)
      .where(eq(a2aTasks.runId, runId))
      .limit(1);
    return row ?? null;
  };

  const runResult = async (runId: string): Promise<string> => {
    const [run] = await db
      .select({ resultText: runRows.resultText })
      .from(runRows)
      .where(eq(runRows.id, runId))
      .limit(1);
    return run?.resultText ?? "";
  };

  /**
   * Moves the task of a run as the run's events say. Register it on both the
   * runs service's `onEvent` (run events) and the shared events `onAppend`
   * (request events). Each case is a compare-and-set, so an event heard twice
   * changes nothing the second time.
   */
  const onEvent = async (event: EventRecord): Promise<void> => {
    if (!(event.runId && handled.has(event.type))) {
      return;
    }
    const task = await taskOfRun(event.runId);
    if (!task || TERMINAL.includes(task.state)) {
      return;
    }
    switch (event.type) {
      case "run.started":
        await move(task.id, ["TASK_STATE_SUBMITTED"], "TASK_STATE_WORKING", {
          statusText: STATUS_TEXT.working,
        });
        return;
      case "run.finished":
        await complete(task.id, await runResult(event.runId));
        return;
      case "run.failed":
        await move(task.id, RUNNING, "TASK_STATE_FAILED", {
          statusText: STATUS_TEXT.failed,
        });
        return;
      case "run.interrupted":
        await move(task.id, RUNNING, "TASK_STATE_FAILED", {
          statusText: STATUS_TEXT.interrupted,
        });
        return;
      case "run.cancelled":
        await move(task.id, RUNNING, "TASK_STATE_CANCELED", {
          statusText: STATUS_TEXT.cancelled,
        });
        return;
      case "request.expired":
        // Nobody answered a peer's question in time. The run is cancelled
        // right after this event, so it cannot ask again.
        if (event.payload.kind === "question") {
          await move(task.id, RUNNING, "TASK_STATE_FAILED", {
            statusText: STATUS_TEXT.unanswered,
          });
          return;
        }
        await settleQuestion(task);
        return;
      default:
        // A question opened, was answered or cancelled.
        await settleQuestion(task);
    }
  };

  const handled: ReadonlySet<EventType> = new Set<EventType>([
    "run.started",
    "run.finished",
    "run.failed",
    "run.cancelled",
    "run.interrupted",
    "request.opened",
    "request.answered",
    "request.cancelled",
    "request.expired",
  ]);

  // ---------------------------------------------------------------------
  // Revoking and sweeping

  /**
   * Runs after a connection is revoked. A message still waiting is rejected,
   * and a task with a run in flight is cancelled along with its run. The peer's
   * access has ended, so no push is queued for any of it and the pushes already
   * queued are dropped. The task changes and the drop land in one atomic write.
   * A run that could not be cancelled here is cancelled by the sweep, which
   * finds a live run under an ended task.
   */
  const onConnectionRevoked = async (revoked: {
    agentId: string;
    connectionId: string;
    workspaceId: string;
  }): Promise<void> => {
    const at = nowIso();
    const where = (states: readonly A2aTaskState[]) =>
      and(
        eq(a2aTasks.connectionId, revoked.connectionId),
        eq(a2aTasks.workspaceId, revoked.workspaceId),
        inArray(a2aTasks.state, [...states])
      );
    const [waiting, live] = await Promise.all([
      db
        .select()
        .from(a2aTasks)
        .where(where(["TASK_STATE_AUTH_REQUIRED"])),
      db.select().from(a2aTasks).where(where(RUNNING)),
    ]);
    await atomic([
      db
        .update(a2aTasks)
        .set({
          state: "TASK_STATE_REJECTED",
          statusText: STATUS_TEXT.connectionRevoked,
          updatedAt: at,
        })
        .where(where(["TASK_STATE_AUTH_REQUIRED"])),
      db
        .update(a2aTasks)
        .set({
          state: "TASK_STATE_CANCELED",
          statusText: STATUS_TEXT.connectionRevoked,
          updatedAt: at,
        })
        .where(where(RUNNING)),
      db
        .delete(a2aOutbox)
        .where(
          and(
            eq(a2aOutbox.connectionId, revoked.connectionId),
            eq(a2aOutbox.kind, "push")
          )
        ),
    ]);
    // Every run is stopped before any event is written, so a failing write
    // cannot leave one running.
    for (const task of live) {
      if (task.runId) {
        // biome-ignore lint/performance/noAwaitInLoops: one cancel at a time keeps the log in order
        await cancelRunQuietly(task.runId);
      }
    }
    try {
      await cancelChainOf(revoked);
    } catch (error) {
      // The sweep finds what is left. The events below still get written.
      console.error("A2A revoke chain not cancelled", error);
    }
    for (const [tasks, type] of [
      [waiting, "a2a.message_declined"],
      [live, "a2a.task_cancelled"],
    ] as const) {
      for (const task of tasks) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: one task at a time keeps the log in order
          await record({
            actor: SYSTEM_ACTOR,
            agentId: revoked.agentId,
            payload: eventPayload(task, { reason: "revoked" }),
            type,
            workspaceId: revoked.workspaceId,
          });
        } catch (error) {
          console.error("A2A revoke event not written", task.id, error);
        }
      }
    }
  };

  /**
   * Live runs whose chain of parents reaches a run a peer's connection set
   * going: a run it started, a hand-off of one, or a wake carrying its answer.
   * The walk goes up from each live run, so a hand-off still counts after its
   * parent has ended. With `connectionId` it is that connection's chain.
   * Without it, any connection that has ended. At most `limit` runs.
   */
  const liveRunsReaching = async (
    scope: { connectionId: string; workspaceId: string } | null,
    limit: number
  ): Promise<string[]> => {
    const rows = await db.all<{ id: string }>(
      liveRunsReachingSql(scope, limit)
    );
    return rows.map(({ id }) => id);
  };

  /**
   * Cancels the live runs a revoked connection's peer set going, hand-offs and
   * wakes included. A batch at a time, a few rounds: `runs.cancelRun` itself
   * stays one run.
   */
  const cancelChainOf = async (revoked: {
    connectionId: string;
    workspaceId: string;
  }): Promise<void> => {
    for (let round = 0; round < REVOKE_ROUNDS; round += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: a cancelled run may have started another, so each round reads again
      const ids = await liveRunsReaching(revoked, SWEEP_BATCH);
      if (ids.length === 0) {
        return;
      }
      for (const id of ids) {
        // biome-ignore lint/performance/noAwaitInLoops: one cancel at a time keeps the log in order
        await cancelRunQuietly(id);
      }
    }
  };

  /**
   * Runs under an ended connection that no task points at: hand-offs, wakes,
   * and children of a parent that ended. Returns how many it cancelled.
   */
  const cancelUnderEndedConnections = async (): Promise<number> => {
    const ids = await liveRunsReaching(null, SWEEP_BATCH);
    for (const id of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: each run is one cancel
      await cancelRunQuietly(id);
    }
    return ids.length;
  };

  /** The least recently swept tasks first, the never swept ones by age. */
  const sweepOrder = [
    asc(sql`coalesce(${a2aTasks.sweptAt}, ${a2aTasks.createdAt})`),
    asc(a2aTasks.id),
  ] as const;

  const stampSwept = async (ids: readonly string[]): Promise<void> => {
    if (ids.length > 0) {
      await db
        .update(a2aTasks)
        .set({ sweptAt: nowIso() })
        .where(inArray(a2aTasks.id, [...ids]));
    }
  };

  /**
   * The minute tick. Catches what an event missed: a task whose run ended or
   * started, a question that opened or closed unheard, a task that never got a
   * run, and a run still alive under a task that has ended. It takes the least
   * recently swept tasks first and stamps them, so a batch of tasks that are
   * fine (a question that waits) moves to the back and cannot hide one that
   * needs acting on. Returns how many tasks and runs it acted on.
   */
  const sweep = async (principal: Principal): Promise<number> => {
    if (principal.kind !== "system") {
      throw new ForbiddenError("a2a.sweep");
    }
    let acted = 0;
    // Tasks still open on a connection that has ended: the revoke hook did not
    // finish, or the task was made while the connection was being revoked.
    const abandoned = await db
      .selectDistinct({
        agentId: a2aConnections.localAgentId,
        connectionId: a2aTasks.connectionId,
        workspaceId: a2aTasks.workspaceId,
      })
      .from(a2aTasks)
      .innerJoin(a2aConnections, eq(a2aConnections.id, a2aTasks.connectionId))
      .where(
        and(
          inArray(a2aTasks.state, ["TASK_STATE_AUTH_REQUIRED", ...RUNNING]),
          inArray(a2aConnections.status, ["revoked", "declined"])
        )
      )
      .limit(SWEEP_CONNECTIONS);
    for (const ended of abandoned) {
      // biome-ignore lint/performance/noAwaitInLoops: one connection at a time keeps the log in order
      await onConnectionRevoked(ended);
      acted += 1;
    }
    const openQuestion = sql`exists (select 1 from ${runRequests} where ${runRequests.runId} = ${a2aTasks.runId} and ${runRequests.kind} = 'question' and ${runRequests.status} = 'pending')`;
    const disagreeing = await db
      .select({
        resultText: runRows.resultText,
        runStatus: runRows.status,
        task: a2aTasks,
      })
      .from(a2aTasks)
      .innerJoin(runRows, eq(runRows.id, a2aTasks.runId))
      .where(
        and(
          inArray(a2aTasks.state, [...RUNNING]),
          or(
            inArray(runRows.status, ENDED_RUN_STATUSES),
            and(
              inArray(runRows.status, ["running", "waiting"]),
              eq(a2aTasks.state, "TASK_STATE_SUBMITTED")
            ),
            and(
              inArray(a2aTasks.state, [
                "TASK_STATE_SUBMITTED",
                "TASK_STATE_WORKING",
              ]),
              openQuestion
            ),
            eq(a2aTasks.state, "TASK_STATE_INPUT_REQUIRED")
          )
        )
      )
      .orderBy(...sweepOrder)
      .limit(SWEEP_BATCH);
    // Stamped before they are looked at, so a task that stays as it is (a
    // question that waits) goes to the back and a full batch of them cannot
    // hide one that needs acting on.
    await stampSwept(disagreeing.map(({ task }) => task.id));
    for (const { resultText, runStatus, task } of disagreeing) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each task is one small read and one write
        acted += (await settle(task, runStatus, resultText ?? "")) ? 1 : 0;
      } catch (error) {
        // One task that cannot be settled must not hold back the rest.
        console.error("A2A task not settled", task.id, error);
      }
    }
    const stale = new Date(
      clock.now().getTime() - NEVER_STARTED_AFTER_MS
    ).toISOString();
    const orphans = await db
      .select({ id: a2aTasks.id })
      .from(a2aTasks)
      .where(
        and(
          eq(a2aTasks.state, "TASK_STATE_SUBMITTED"),
          isNull(a2aTasks.runId),
          lt(a2aTasks.updatedAt, stale)
        )
      )
      .limit(SWEEP_BATCH);
    for (const { id } of orphans) {
      // biome-ignore lint/performance/noAwaitInLoops: each task is one write
      const failed = await move(
        id,
        ["TASK_STATE_SUBMITTED"],
        "TASK_STATE_FAILED",
        { statusText: STATUS_TEXT.notStarted }
      );
      acted += failed ? 1 : 0;
    }
    const strays = await db
      .select({ runId: runRows.id, taskId: a2aTasks.id })
      .from(runRows)
      .innerJoin(a2aTasks, eq(a2aTasks.runId, runRows.id))
      .where(
        and(
          inArray(runRows.status, [...LIVE_RUN_STATUSES]),
          inArray(a2aTasks.state, [...TERMINAL])
        )
      )
      .orderBy(...sweepOrder)
      .limit(SWEEP_BATCH);
    await stampSwept(strays.map(({ taskId }) => taskId));
    for (const { runId } of strays) {
      // biome-ignore lint/performance/noAwaitInLoops: each run is one cancel
      await cancelRunQuietly(runId);
      acted += 1;
    }
    acted += await cancelUnderEndedConnections();
    return acted;
  };

  /** What the run's own state says the task should be, applied when it differs. */
  const settle = async (
    task: TaskRow,
    runStatus: string,
    resultText: string
  ): Promise<TaskRow | null> => {
    switch (runStatus) {
      case "done":
        return await complete(task.id, resultText);
      case "failed":
        return await move(task.id, RUNNING, "TASK_STATE_FAILED", {
          statusText: STATUS_TEXT.failed,
        });
      case "interrupted":
        return await move(task.id, RUNNING, "TASK_STATE_FAILED", {
          statusText: STATUS_TEXT.interrupted,
        });
      case "cancelled":
        return await move(task.id, RUNNING, "TASK_STATE_CANCELED", {
          statusText: STATUS_TEXT.cancelled,
        });
      case "running":
      case "waiting": {
        const started = await move(
          task.id,
          ["TASK_STATE_SUBMITTED"],
          "TASK_STATE_WORKING",
          { statusText: STATUS_TEXT.working }
        );
        const current = await taskById(task.id);
        const asked = current ? await settleQuestion(current) : null;
        return started ?? asked;
      }
      default:
        return null;
    }
  };

  /**
   * Makes the task say what the run's open questions say: the oldest one's text
   * with the state `INPUT_REQUIRED`, or `WORKING` once none is open.
   */
  const settleQuestion = async (task: TaskRow): Promise<TaskRow | null> => {
    if (!task.runId || TERMINAL.includes(task.state)) {
      return null;
    }
    const [pending] = await pendingQuestions(task.runId, 1);
    if (!pending) {
      return await move(
        task.id,
        ["TASK_STATE_INPUT_REQUIRED"],
        "TASK_STATE_WORKING",
        { statusText: STATUS_TEXT.working }
      );
    }
    const parsed = questionDisplaySchema.safeParse(parseJson(pending.display));
    if (!parsed.success) {
      return null;
    }
    const text = questionStatusText(parsed.data.questions);
    if (
      task.state === "TASK_STATE_INPUT_REQUIRED" &&
      task.statusText === text
    ) {
      return null;
    }
    return await move(
      task.id,
      [
        "TASK_STATE_SUBMITTED",
        "TASK_STATE_WORKING",
        "TASK_STATE_INPUT_REQUIRED",
      ],
      "TASK_STATE_INPUT_REQUIRED",
      { statusText: text }
    );
  };

  return {
    approveTask,
    cancelTask,
    createPushConfig,
    declineTask,
    deletePushConfig,
    gateway,
    getPushConfig,
    getTask,
    listPushConfigs,
    listTasks,
    listWaiting,
    onConnectionRevoked,
    onEvent,
    sendMessage,
    sweep,
  };
};

export type A2aTasksService = ReturnType<typeof createA2aTasksService>;
