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
import {
  a2aConnections,
  a2aOutboundTasks,
  a2aOutbox,
  a2aTasks,
} from "@repo/db/schema/a2a";
import { agents } from "@repo/db/schema/agents";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import type { A2aTaskState, EventActorKind, EventType } from "@repo/db/shared";
import { questionDisplaySchema } from "@repo/protocol/requests";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
} from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "../authz.ts";
import { isUniqueViolation, ServiceError } from "../errors.ts";
import type { EventRecord, EventsService } from "../events.ts";
import type { RequestsService } from "../requests.ts";
import { MAX_RUN_DEPTH } from "../runs/subject.ts";
import {
  type Clock,
  type Gateway,
  INPUT_TEXT_MAX,
  type StartRunInput,
  type StartRunOptions,
} from "../runs/types.ts";
import { buildPeerEnvelope } from "../speaker-envelope.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { requireReader, requireSession } from "./access.ts";
import type { PeerPrincipal } from "./connections.ts";
import { A2aRateLimitError, A2aTaskError } from "./errors.ts";
import type { WaitingMessage } from "./needs-you.ts";
import {
  createPushConfigs,
  type PushConfigInput,
  type PushConfigView,
} from "./push-configs.ts";
import {
  hopsOf,
  hostOf,
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

const HOUR_MS = 60 * 60_000;
const MINUTE_MS = 60_000;
const MS_PER_SECOND = 1000;
/** A task that stayed `SUBMITTED` this long with no run never will get one. */
const NEVER_STARTED_AFTER_MS = 5 * MINUTE_MS;
/** Tasks the minute sweep looks at in one go. */
const SWEEP_BATCH = 100;
const WAITING_LIST_CAP = 200;
const MESSAGE_ID_MAX = 200;
const CONTEXT_ID_MAX = 100;
/** Peer text longer than this is refused. The envelope adds some more. */
export const MESSAGE_TEXT_MAX = 30_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const UNKNOWN_HOST = "unknown host";

const SYSTEM_ACTOR = { id: "tick", kind: "system" } as const;

const idString = z.string().min(1).max(200);
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
  clock: Clock;
  db: Database;
  events: EventsService;
  requests: Pick<RequestsService, "answerAsPeer">;
  runs: {
    cancelRun: (principal: Principal, runId: string) => Promise<void>;
    startRun: (
      principal: Principal,
      input: StartRunInput,
      options?: StartRunOptions
    ) => Promise<unknown>;
  };
  /** `SECRETS_KEY`. Storing a push credential encrypts with it. */
  secretsKey?: string;
}

type ConnectionRow = typeof a2aConnections.$inferSelect;

/** What `move` writes besides the new state. */
interface Patch {
  decidedBy?: string;
  /** Queue push rows. Off when a revoke ends the task, because the peer hears nothing more. */
  push?: boolean;
  resultText?: string | null;
  statusText: string | null;
}

const eventPayload = (
  row: { connectionId: string; id: string },
  extra: Record<string, string | number | boolean | null> = {}
) => ({ connectionId: row.connectionId, taskId: row.id, ...extra });

export const createA2aTasksService = ({
  clock,
  db,
  events,
  requests,
  runs,
  secretsKey,
}: A2aTasksOptions) => {
  const pushConfigs = createPushConfigs({ clock, db, secretsKey });
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
    peer: PeerPrincipal
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
      throw new ForbiddenError(SEND_ACTION);
    }
    return row;
  };

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
   * Moves a task from one of the states `from` to `to`, and queues its pushes
   * when this call is the one that moved it. Null when the task was not in any
   * of them, which is how a race loser or a repeated event finds out.
   */
  const move = async (
    id: string,
    from: readonly A2aTaskState[],
    to: A2aTaskState,
    patch: Patch
  ): Promise<TaskRow | null> => {
    const at = nowIso();
    const [row] = await db
      .update(a2aTasks)
      .set({
        ...(patch.decidedBy === undefined
          ? {}
          : { decidedAt: at, decidedBy: patch.decidedBy }),
        ...(patch.resultText === undefined
          ? {}
          : { resultText: patch.resultText }),
        state: to,
        statusText: patch.statusText,
        updatedAt: at,
      })
      .where(and(eq(a2aTasks.id, id), inArray(a2aTasks.state, [...from])))
      .returning();
    if (!row) {
      return null;
    }
    if (patch.push !== false) {
      try {
        await pushConfigs.queueFor(row);
      } catch (error) {
        console.error("A2A push not queued", row.id, error);
      }
    }
    return row;
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

  /** Tasks in the last hour in both directions, and when the oldest one drops out. */
  const hourlyUse = async (
    connection: ConnectionRow
  ): Promise<{ oldest: string | null; used: number }> => {
    const since = new Date(clock.now().getTime() - HOUR_MS).toISOString();
    const [inbound, outbound] = await Promise.all([
      db
        .select({ at: a2aTasks.createdAt })
        .from(a2aTasks)
        .where(
          and(
            eq(a2aTasks.connectionId, connection.id),
            gt(a2aTasks.createdAt, since)
          )
        ),
      db
        .select({ at: a2aOutboundTasks.createdAt })
        .from(a2aOutboundTasks)
        .where(
          and(
            eq(a2aOutboundTasks.connectionId, connection.id),
            gt(a2aOutboundTasks.createdAt, since)
          )
        ),
    ]);
    const times = [...inbound, ...outbound].map(({ at }) => at).sort();
    return { oldest: times[0] ?? null, used: times.length };
  };

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
    const { oldest, used } = await hourlyUse(connection);
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

  /**
   * An agent on the managed runtime never asks `needsApproval`, so its tool
   * calls could not be held for a person. Publishing refuses it, and a message
   * to one that was published earlier is refused here too.
   */
  const requireGateableAgent = async (connection: ConnectionRow) => {
    const [agent] = await db
      .select({ runtime: agents.runtime, status: agents.status })
      .from(agents)
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

  const startRunFor = async (
    connection: ConnectionRow,
    task: TaskRow
  ): Promise<void> => {
    const peer: PeerPrincipal = {
      agentId: connection.localAgentId,
      connectionId: connection.id,
      hops: task.hops,
      kind: "peer",
      workspaceId: connection.workspaceId,
    };
    try {
      await runs.startRun(
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
            db
              .update(a2aTasks)
              .set({ runId, updatedAt: nowIso() })
              .where(eq(a2aTasks.id, task.id)),
          ],
        }
      );
    } catch (error) {
      await move(task.id, ["TASK_STATE_SUBMITTED"], "TASK_STATE_FAILED", {
        statusText: STATUS_TEXT.notStarted,
      });
      throw error;
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
    const [question] =
      task.state === "TASK_STATE_INPUT_REQUIRED" && task.runId
        ? await db
            .select({ id: runRequests.id })
            .from(runRequests)
            .where(
              and(
                eq(runRequests.runId, task.runId),
                eq(runRequests.kind, "question"),
                eq(runRequests.status, "pending")
              )
            )
            .orderBy(desc(runRequests.createdAt))
            .limit(1)
        : [];
    if (!question) {
      throw new A2aTaskError(
        "UnsupportedOperationError",
        "The task is not waiting for an answer."
      );
    }
    let closed = false;
    try {
      await requests.answerAsPeer(peer, { requestId: question.id, text });
    } catch (error) {
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
    await record({
      actor: peerActor(connection),
      agentId: connection.localAgentId,
      payload: eventPayload(task, { answer: true, chars: text.length }),
      type: "a2a.message_received",
      workspaceId: connection.workspaceId,
    });
    await move(task.id, ["TASK_STATE_INPUT_REQUIRED"], "TASK_STATE_WORKING", {
      statusText: STATUS_TEXT.working,
    });
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
    try {
      await db.insert(a2aTasks).values(row);
    } catch (error) {
      const winner = isUniqueViolation(error)
        ? await byMessageId(connection.id, message.messageId)
        : null;
      if (!winner) {
        throw error;
      }
      return winner;
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
   * A peer's `SendMessage`. Returns the task as it stands: waiting for a
   * person, or queued. Blocking until it settles is the route's job.
   */
  const sendMessage = async (
    peer: PeerPrincipal,
    raw: SendMessageRequest
  ): Promise<Task> => {
    const request = sendMessageRequestSchema.parse(raw);
    const connection = await requireConnection(peer);
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
    const connection = await requireConnection(peer);
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
    const connection = await requireConnection(peer);
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
        : gt(a2aTasks.updatedAt, input.statusTimestampAfter)
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
    const connection = await requireConnection(peer);
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
    if (task.runId) {
      await cancelRunQuietly(task.runId);
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
      console.error("A2A run not cancelled", runId, error);
    }
  };

  // ---------------------------------------------------------------------
  // Push configurations

  const requirePushTask = async (peer: PeerPrincipal, taskId: string) => {
    const connection = await requireConnection(peer);
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

  const questionsOf = async (requestId: string) => {
    const [row] = await db
      .select({ display: runRequests.display, kind: runRequests.kind })
      .from(runRequests)
      .where(eq(runRequests.id, requestId))
      .limit(1);
    if (row?.kind !== "question") {
      return null;
    }
    const parsed = questionDisplaySchema.safeParse(JSON.parse(row.display));
    return parsed.success ? parsed.data.questions : null;
  };

  const hasPendingQuestion = async (runId: string): Promise<boolean> => {
    const [pending] = await db
      .select({ id: runRequests.id })
      .from(runRequests)
      .where(
        and(
          eq(runRequests.runId, runId),
          eq(runRequests.kind, "question"),
          eq(runRequests.status, "pending")
        )
      )
      .limit(1);
    return pending !== undefined;
  };

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
      case "request.opened": {
        const { requestId } = event.payload;
        const questions =
          typeof requestId === "string" ? await questionsOf(requestId) : null;
        if (questions) {
          await move(
            task.id,
            ["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"],
            "TASK_STATE_INPUT_REQUIRED",
            { statusText: questionStatusText(questions) }
          );
        }
        return;
      }
      default:
        // The question was answered, cancelled or expired.
        if (!(await hasPendingQuestion(event.runId))) {
          await move(
            task.id,
            ["TASK_STATE_INPUT_REQUIRED"],
            "TASK_STATE_WORKING",
            { statusText: STATUS_TEXT.working }
          );
        }
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
   * queued are dropped.
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
    const declined = await db
      .update(a2aTasks)
      .set({
        state: "TASK_STATE_REJECTED",
        statusText: STATUS_TEXT.connectionRevoked,
        updatedAt: at,
      })
      .where(where(["TASK_STATE_AUTH_REQUIRED"]))
      .returning();
    const cancelled = await db
      .update(a2aTasks)
      .set({
        state: "TASK_STATE_CANCELED",
        statusText: STATUS_TEXT.connectionRevoked,
        updatedAt: at,
      })
      .where(where(RUNNING))
      .returning();
    await db
      .delete(a2aOutbox)
      .where(
        and(
          eq(a2aOutbox.connectionId, revoked.connectionId),
          eq(a2aOutbox.kind, "push")
        )
      );
    for (const task of [...declined, ...cancelled]) {
      // biome-ignore lint/performance/noAwaitInLoops: one task at a time keeps the log in order
      await record({
        actor: SYSTEM_ACTOR,
        agentId: revoked.agentId,
        payload: eventPayload(task, { reason: "revoked" }),
        type:
          task.state === "TASK_STATE_REJECTED"
            ? "a2a.message_declined"
            : "a2a.task_cancelled",
        workspaceId: revoked.workspaceId,
      });
      if (task.runId) {
        await cancelRunQuietly(task.runId);
      }
    }
  };

  /**
   * The minute tick. Catches what an event missed: a task whose run ended or
   * started, a question that opened or closed unheard, and a task that never
   * got a run. Returns how many tasks it moved.
   */
  const sweep = async (principal: Principal): Promise<number> => {
    if (principal.kind !== "system") {
      throw new ForbiddenError("a2a.sweep");
    }
    let moved = 0;
    const live = await db
      .select({
        resultText: runRows.resultText,
        runStatus: runRows.status,
        task: a2aTasks,
      })
      .from(a2aTasks)
      .innerJoin(runRows, eq(runRows.id, a2aTasks.runId))
      .where(
        and(inArray(a2aTasks.state, [...RUNNING]), isNotNull(a2aTasks.runId))
      )
      .orderBy(asc(a2aTasks.updatedAt))
      .limit(SWEEP_BATCH);
    for (const { resultText, runStatus, task } of live) {
      // biome-ignore lint/performance/noAwaitInLoops: each task is one small read and one write
      const next = await settle(task, runStatus, resultText ?? "");
      moved += next ? 1 : 0;
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
        {
          statusText: STATUS_TEXT.notStarted,
        }
      );
      moved += failed ? 1 : 0;
    }
    return moved;
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
        return await move(
          task.id,
          ["TASK_STATE_SUBMITTED"],
          "TASK_STATE_WORKING",
          { statusText: STATUS_TEXT.working }
        );
      case "waiting":
        return await settleQuestion(task);
      default:
        return null;
    }
  };

  const settleQuestion = async (task: TaskRow): Promise<TaskRow | null> => {
    if (!task.runId) {
      return null;
    }
    const [pending] = await db
      .select({ display: runRequests.display })
      .from(runRequests)
      .where(
        and(
          eq(runRequests.runId, task.runId),
          eq(runRequests.kind, "question"),
          eq(runRequests.status, "pending")
        )
      )
      .orderBy(desc(runRequests.createdAt))
      .limit(1);
    if (!pending) {
      return await move(
        task.id,
        ["TASK_STATE_INPUT_REQUIRED"],
        "TASK_STATE_WORKING",
        { statusText: STATUS_TEXT.working }
      );
    }
    if (task.state === "TASK_STATE_INPUT_REQUIRED") {
      return null;
    }
    const parsed = questionDisplaySchema.safeParse(JSON.parse(pending.display));
    return parsed.success
      ? await move(
          task.id,
          ["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"],
          "TASK_STATE_INPUT_REQUIRED",
          { statusText: questionStatusText(parsed.data.questions) }
        )
      : null;
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
