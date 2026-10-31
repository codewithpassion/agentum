/**
 * Our agent calling a peer. `send` applies the connection's `outbound_policy`
 * (off refuses, `approve` waits behind a card a person answers, `auto` sends),
 * the hourly limit and the hop count, and writes an `a2a_outbound_tasks` row
 * keyed by `requestId` so a retry does not send twice. The result reaches the
 * row by polling `GetTask` from the minute tick and by a per-task webhook that
 * is only a nudge to poll at once: a peer's body is never trusted. When a
 * result arrives and the calling run has ended, a follow-up run in the same
 * session carries it. The spec is docs/v3/agent-connections.md ("Our agent
 * calling a peer", "Hermes compatibility").
 *
 * No state lives on the service instance, because `composeWith` builds one per
 * request. Every race is decided by the database: a compare-and-set on the
 * state, or on `result_read_at` for a wake.
 */

import { agentCardSchema } from "@repo/a2a/agent-card";
import {
  A2aClientError,
  type ClientCredential,
  createA2aClient,
  pickInterface,
  taskText,
} from "@repo/a2a/client";
import { HOPS_METADATA_KEY } from "@repo/a2a/extensions";
import type { A2aFetch } from "@repo/a2a/peer-fetch";
import type { Task } from "@repo/a2a/tasks";
import type { Database } from "@repo/db";
import { a2aConnections, a2aOutboundTasks } from "@repo/db/schema/a2a";
import { runRequests } from "@repo/db/schema/requests";
import { sessions } from "@repo/db/schema/sessions";
import {
  A2A_SEND_TOOL,
  type A2aTaskState,
  type EventActorKind,
  type EventType,
} from "@repo/db/shared";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "../authz.ts";
import {
  decryptSecret,
  hashToken,
  importSecretsKey,
  type SecretBinding,
  toBase64Url,
  tokenMatchesHash,
} from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import { capInput } from "../requests/records.ts";
import type { RequestsService } from "../requests.ts";
import { loadRun } from "../runs/queries.ts";
import { MAX_RUN_DEPTH } from "../runs/subject.ts";
import {
  type Clock,
  type RunRecord,
  type StartRunInput,
  type StartRunOptions,
  TERMINAL_STATUSES,
} from "../runs/types.ts";
import { buildPeerEnvelope } from "../speaker-envelope.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { CONNECTION_KIND } from "./access.ts";
import { schemeKindOfLabel, tokenUrlOfLabel } from "./card-peer.ts";
import { A2aRateLimitError } from "./errors.ts";
import { HOUR_MS, hourlyCountSql, hourlyUse } from "./hourly.ts";
import { interfaceBaseOfCardUrl } from "./urls.ts";

export const SEND_ACTION = "a2a.outbound.send";
export const READ_ACTION = "a2a.outbound.read";

/** The longest message we send and the longest answer we keep. */
export const OUTBOUND_TEXT_MAX = 30_000;
const STATUS_TEXT_MAX = 2000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * HOUR_MS;
/** How long we poll a task. After this the task is failed locally. */
export const POLL_WINDOW_MS = DAY_MS;
/** A message the peer never showed us, given up on after this long. */
const UNCONFIRMED_AFTER_MS = 10 * MINUTE_MS;
/** Polls come each minute for the first hour, then every five. */
const FAST_POLL_MS = MINUTE_MS;
const SLOW_POLL_MS = 5 * MINUTE_MS;
const FAST_POLL_FOR_MS = HOUR_MS;
const POLL_BATCH = 20;
const WAKE_BATCH = 20;
const SETTLE_BATCH = 20;
const CONCURRENCY = 5;
/** `get` asks the peer again only when the row is older than this. */
const GET_REFRESH_MS = 5000;
const MESSAGE_ID_MAX = 200;
const TASK_NOT_FOUND_CODE = -32_001;
const TRAILING_SLASHES = /\/+$/;

const TERMINAL_STATES: readonly A2aTaskState[] = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
];

const WAKE_STATES: readonly A2aTaskState[] = TERMINAL_STATES;

const isTerminal = (state: A2aTaskState): boolean =>
  TERMINAL_STATES.includes(state);

type OutboundRow = typeof a2aOutboundTasks.$inferSelect;
type ConnectionRow = typeof a2aConnections.$inferSelect;

export const sendInputSchema = z.strictObject({
  connection: z.string().min(1).max(MESSAGE_ID_MAX),
  requestId: z.string().min(1).max(MESSAGE_ID_MAX),
  text: z.string().trim().min(1).max(OUTBOUND_TEXT_MAX),
});
export type SendInput = z.input<typeof sendInputSchema>;

/**
 * A task as the agent tools show it: the `RunInfo` shape `send_message` and
 * `get_run` already use, with the words for what a waiting task waits for.
 * `runId` is the outbound task id. `status` is one of `queued`, `running`,
 * `waiting`, `done`, `failed` and `cancelled`.
 */
export interface OutboundTaskInfo {
  agentId: string;
  answer: string | null;
  error: string | null;
  runId: string;
  sessionId: string;
  status: string;
  statusText: string;
}

const STATUS_OF: Record<A2aTaskState, string> = {
  TASK_STATE_AUTH_REQUIRED: "waiting",
  TASK_STATE_CANCELED: "cancelled",
  TASK_STATE_COMPLETED: "done",
  TASK_STATE_FAILED: "failed",
  TASK_STATE_INPUT_REQUIRED: "waiting",
  TASK_STATE_REJECTED: "failed",
  TASK_STATE_SUBMITTED: "queued",
  TASK_STATE_WORKING: "running",
};

const WAITING_APPROVAL =
  "Waiting for a person to approve sending this message.";

const capText = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const storedOauthSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.array(z.string()).default([]),
  tokenUrl: z.string().min(1),
});

export interface OutboundOptions {
  clock: Clock;
  db: Database;
  events: EventsService;
  /** Reaches the peer. Refuses private addresses and redirects, and dispatches in-process for our own origin. */
  fetch: A2aFetch;
  /** `PUBLIC_BASE_URL`. A push webhook is only registered under it. */
  publicBaseUrl?: string;
  requests: Pick<RequestsService, "open">;
  runs: {
    startRun: (
      principal: Principal,
      input: StartRunInput,
      options?: StartRunOptions
    ) => Promise<{ runId: string }>;
  };
  /** `SECRETS_KEY`. Reads the stored credential and derives the webhook token. */
  secretsKey?: string;
}

/** Which agent's connection a run principal may use. */
const requireOwnRun = (
  principal: Principal,
  connection: Pick<ConnectionRow, "localAgentId" | "workspaceId">,
  action: string
): void => {
  if (principal.kind === "system") {
    return;
  }
  if (
    principal.kind !== "run" ||
    principal.agentId !== connection.localAgentId ||
    principal.workspaceId !== connection.workspaceId
  ) {
    throw new ForbiddenError(action);
  }
};

export const createOutboundService = ({
  clock,
  db,
  events,
  fetch,
  publicBaseUrl,
  requests,
  runs,
  secretsKey,
}: OutboundOptions) => {
  let importedKey: Promise<CryptoKey> | undefined;
  const aesKey = (): Promise<CryptoKey> => {
    if (!secretsKey) {
      throw new Error("Calling a peer needs secretsKey (SECRETS_KEY).");
    }
    importedKey ??= importSecretsKey(secretsKey);
    return importedKey;
  };
  const unseal = async (binding: SecretBinding, stored: string) =>
    await decryptSecret(await aesKey(), binding, stored);

  const nowIso = () => clock.now().toISOString();
  const later = (ms: number) =>
    new Date(clock.now().getTime() + ms).toISOString();

  // ---------------------------------------------------------------------
  // Small helpers

  const record = async (input: {
    actor: { id: string; kind: EventActorKind };
    agentId: string;
    payload: Record<string, string | number | boolean | null>;
    runId?: string;
    sessionId?: string;
    type: EventType;
    workspaceId: string;
  }): Promise<void> => {
    await events.append({
      actor: input.actor,
      agentId: input.agentId,
      payload: input.payload,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      type: input.type,
      workspaceId: input.workspaceId,
    });
  };

  const SYSTEM_ACTOR = { id: "tick", kind: "system" } as const;

  const connectionById = async (id: string): Promise<ConnectionRow | null> => {
    const [row] = await db
      .select()
      .from(a2aConnections)
      .where(eq(a2aConnections.id, id))
      .limit(1);
    return row ?? null;
  };

  const taskById = async (id: string): Promise<OutboundRow | null> => {
    const [row] = await db
      .select()
      .from(a2aOutboundTasks)
      .where(eq(a2aOutboundTasks.id, id))
      .limit(1);
    return row ?? null;
  };

  const requireTask = async (id: string): Promise<OutboundRow> => {
    const row = await taskById(id);
    if (!row) {
      throw new ServiceError("not_found", "Task not found");
    }
    return row;
  };

  const hostOf = (origin: string | null): string => {
    try {
      return origin === null ? "unknown host" : new URL(origin).host;
    } catch {
      return "unknown host";
    }
  };

  const peerName = (connection: ConnectionRow): string =>
    connection.peerLabel ?? connection.slug;

  const infoOf = (row: OutboundRow, agentId: string): OutboundTaskInfo => {
    const status = STATUS_OF[row.state];
    const failed = status === "failed" || status === "cancelled";
    return {
      agentId,
      answer: row.state === "TASK_STATE_COMPLETED" ? row.resultText : null,
      error: failed ? (row.resultText ?? statusTextOf(row)) : null,
      runId: row.id,
      sessionId: row.sessionId,
      status,
      statusText: statusTextOf(row),
    };
  };

  /** What the task says about itself, in plain words. Never the peer's raw error. */
  const statusTextOf = (row: OutboundRow): string => {
    if (row.state === "TASK_STATE_COMPLETED") {
      return "The peer answered.";
    }
    return row.resultText ?? STATUS_DEFAULT[row.state];
  };

  const STATUS_DEFAULT: Record<A2aTaskState, string> = {
    TASK_STATE_AUTH_REQUIRED: WAITING_APPROVAL,
    TASK_STATE_CANCELED: "The peer cancelled the task.",
    TASK_STATE_COMPLETED: "The peer answered.",
    TASK_STATE_FAILED: "The task failed.",
    TASK_STATE_INPUT_REQUIRED: "The peer is waiting for more input.",
    TASK_STATE_REJECTED: "The peer refused the task.",
    TASK_STATE_SUBMITTED: "The message is on its way to the peer.",
    TASK_STATE_WORKING: "The peer is working on it.",
  };

  const agentIdOf = async (row: OutboundRow): Promise<string> => {
    const connection = await connectionById(row.connectionId);
    return connection?.localAgentId ?? "";
  };

  const view = async (row: OutboundRow): Promise<OutboundTaskInfo> =>
    infoOf(row, await agentIdOf(row));

  // ---------------------------------------------------------------------
  // Reaching the peer

  /** The webhook token of a task. Derived, so the dispatch after an approval can rebuild it. */
  const webhookToken = async (taskId: string): Promise<string | null> => {
    if (!secretsKey) {
      return null;
    }
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secretsKey),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`a2a-webhook:${taskId}`)
    );
    return toBase64Url(new Uint8Array(mac));
  };

  const credentialBinding = (row: ConnectionRow): SecretBinding => ({
    field: "outbound_credential",
    rowId: row.id,
    table: "a2a_connections",
    workspaceId: row.workspaceId,
  });

  const credentialOf = async (
    row: ConnectionRow
  ): Promise<ClientCredential> => {
    const kind =
      row.peerKind === "harbourmaster"
        ? "bearer"
        : (schemeKindOfLabel(row.outboundScheme) ?? "none");
    if (kind === "none") {
      return { kind: "none" };
    }
    if (!row.outboundCredential) {
      throw new ServiceError(
        "conflict",
        "This connection holds no credential."
      );
    }
    const plain = await unseal(credentialBinding(row), row.outboundCredential);
    if (kind === "bearer") {
      return { kind: "bearer", token: plain };
    }
    if (kind === "api_key_header") {
      const headerName = (row.outboundScheme ?? "").slice(
        "api_key_header:".length
      );
      return { headerName, kind: "api_key_header", value: plain };
    }
    if (kind === "oauth2_client_credentials") {
      const stored = storedOauthSchema.safeParse(JSON.parse(plain));
      // The secret goes only where a person approved: the label carries the token URL.
      if (
        !stored.success ||
        stored.data.tokenUrl !== tokenUrlOfLabel(row.outboundScheme)
      ) {
        throw new ServiceError(
          "conflict",
          "The stored credential cannot be used. Remove the agent and add it again."
        );
      }
      return {
        clientId: stored.data.clientId,
        clientSecret: stored.data.clientSecret,
        kind: "oauth2_client_credentials",
        scopes: stored.data.scopes,
        tokenUrl: stored.data.tokenUrl,
      };
    }
    throw new ServiceError("conflict", "This connection cannot be called.");
  };

  /** Where to call the peer, and whether it takes push. Null when the card does not match the approved origin. */
  const destinationOf = (
    row: ConnectionRow
  ): {
    binding: "HTTP+JSON" | "JSONRPC";
    push: boolean;
    url: string;
  } | null => {
    if (row.peerKind === "harbourmaster") {
      if (!(row.peerCardUrl && row.peerOrigin)) {
        return null;
      }
      const url = `${interfaceBaseOfCardUrl(row.peerCardUrl)}/rpc`;
      return new URL(url).origin === row.peerOrigin
        ? { binding: "JSONRPC", push: true, url }
        : null;
    }
    if (row.peerKind !== "a2a_outbound" || !row.peerCard) {
      return null;
    }
    const parsed = agentCardSchema.safeParse(JSON.parse(row.peerCard));
    if (!parsed.success) {
      return null;
    }
    const picked = pickInterface(parsed.data);
    // A card that moved to another origin waits for a person; nothing goes there.
    if (!picked || picked.origin !== row.peerOrigin) {
      return null;
    }
    return {
      binding: picked.binding,
      push: parsed.data.capabilities.pushNotifications === true,
      url: picked.url,
    };
  };

  const clientFor = async (row: ConnectionRow) => {
    const destination = destinationOf(row);
    if (!destination) {
      throw new ServiceError(
        "conflict",
        "This connection's destination is not approved. A person must look at it again."
      );
    }
    return {
      client: createA2aClient({
        credential: await credentialOf(row),
        fetch,
        interface: { binding: destination.binding, url: destination.url },
        now: () => clock.now().getTime(),
      }),
      destination,
    };
  };

  // ---------------------------------------------------------------------
  // Moving a row

  const nextPollAt = (row: Pick<OutboundRow, "createdAt">): string =>
    later(
      clock.now().getTime() - Date.parse(row.createdAt) < FAST_POLL_FOR_MS
        ? FAST_POLL_MS
        : SLOW_POLL_MS
    );

  /** Ends a task from our side. It wakes nothing: the agent reads it with `get`. */
  const failLocal = async (
    row: OutboundRow,
    reason: string,
    state: A2aTaskState = "TASK_STATE_FAILED"
  ): Promise<OutboundRow> => {
    await db
      .update(a2aOutboundTasks)
      .set({
        nextPollAt: null,
        resultReadAt: nowIso(),
        resultText: capText(reason, STATUS_TEXT_MAX),
        state,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(a2aOutboundTasks.id, row.id),
          sql`${a2aOutboundTasks.state} not in ('TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED')`
        )
      );
    return (await taskById(row.id)) ?? row;
  };

  /**
   * Takes what the peer says its task is into the row. Only a row that is not
   * over yet moves, so a terminal state never reverts and a duplicate poll or
   * push changes nothing.
   */
  const applyRemote = async (
    row: OutboundRow,
    remote: Task
  ): Promise<OutboundRow> => {
    const { state } = remote.status;
    const statusText = remote.status.message
      ? capText(taskText({ ...remote, artifacts: undefined }), STATUS_TEXT_MAX)
      : "";
    const text = isTerminal(state) ? taskText(remote) : "";
    const result =
      state === "TASK_STATE_COMPLETED"
        ? capText(text, OUTBOUND_TEXT_MAX)
        : capText(text || statusText, STATUS_TEXT_MAX);
    const [moved] = await db
      .update(a2aOutboundTasks)
      .set({
        nextPollAt: isTerminal(state) ? null : nextPollAt(row),
        remoteTaskId: row.remoteTaskId ?? remote.id,
        resultText: isTerminal(state) ? result : statusText || row.resultText,
        state,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(a2aOutboundTasks.id, row.id),
          sql`${a2aOutboundTasks.state} not in ('TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED')`
        )
      )
      .returning();
    const after = moved ?? (await taskById(row.id)) ?? row;
    if (moved && isTerminal(state)) {
      const connection = await connectionById(row.connectionId);
      if (connection) {
        await record({
          actor: { id: connection.id, kind: "peer" },
          agentId: connection.localAgentId,
          payload: {
            connectionId: connection.id,
            outboundTaskId: row.id,
            state,
          },
          sessionId: row.sessionId,
          type: "a2a.result_received",
          workspaceId: row.workspaceId,
        });
      }
      await wake(after);
    }
    return after;
  };

  /** Asks the peer where the task stands, by id or, before we know its id, by our context. */
  const refresh = async (row: OutboundRow): Promise<OutboundRow> => {
    if (isTerminal(row.state)) {
      return row;
    }
    const connection = await connectionById(row.connectionId);
    if (connection?.status !== "active") {
      return await failLocal(row, "The connection is no longer active.");
    }
    try {
      const { client } = await clientFor(connection);
      if (row.remoteTaskId) {
        return await applyRemote(row, await client.getTask(row.remoteTaskId));
      }
      return await adoptByContext(row, connection);
    } catch (error) {
      return await failedRefresh(row, error);
    }
  };

  /** Finds the task the peer made for our context, when SendMessage did not tell us. */
  const adoptByContext = async (
    row: OutboundRow,
    connection: ConnectionRow
  ): Promise<OutboundRow> => {
    const { client } = await clientFor(connection);
    const found = (
      await client.listTasks({ contextId: row.contextId ?? "" })
    ).find((task) => task.contextId === row.contextId);
    if (found) {
      return await applyRemote(row, found);
    }
    if (
      clock.now().getTime() - Date.parse(row.createdAt) >
      UNCONFIRMED_AFTER_MS
    ) {
      return await failLocal(
        row,
        "The peer never confirmed it received the message."
      );
    }
    return await touch(row);
  };

  /** A transient failure keeps the row and tries again at the next poll. A peer that forgot the task ends it. */
  const failedRefresh = async (
    row: OutboundRow,
    error: unknown
  ): Promise<OutboundRow> => {
    if (
      error instanceof A2aClientError &&
      error.rpcCode === TASK_NOT_FOUND_CODE
    ) {
      return await failLocal(row, "The peer no longer knows this task.");
    }
    if (error instanceof ServiceError) {
      return await failLocal(row, error.message);
    }
    return await touch(row);
  };

  /** Marks the row looked at and schedules the next poll. */
  const touch = async (row: OutboundRow): Promise<OutboundRow> => {
    const [updated] = await db
      .update(a2aOutboundTasks)
      .set({ nextPollAt: nextPollAt(row), updatedAt: nowIso() })
      .where(
        and(
          eq(a2aOutboundTasks.id, row.id),
          isNotNull(a2aOutboundTasks.nextPollAt)
        )
      )
      .returning();
    return updated ?? (await taskById(row.id)) ?? row;
  };

  // ---------------------------------------------------------------------
  // Sending

  const messageFor = (
    row: OutboundRow,
    hops: number
  ): {
    contextId: string;
    messageId: string;
    metadata: Record<string, number>;
    parts: { mediaType: string; text: string }[];
    role: "ROLE_USER";
  } => ({
    contextId: row.contextId ?? row.id,
    messageId: row.id,
    metadata: { [HOPS_METADATA_KEY]: hops },
    parts: [{ mediaType: "text/plain", text: row.text }],
    role: "ROLE_USER",
  });

  /** Registers the per-task webhook. A peer that refuses it is polled all the same. */
  const registerPush = async (
    row: OutboundRow,
    client: Awaited<ReturnType<typeof clientFor>>["client"],
    remoteTaskId: string
  ): Promise<void> => {
    const token = await webhookToken(row.id);
    if (!(token && publicBaseUrl)) {
      return;
    }
    const base = publicBaseUrl.replace(TRAILING_SLASHES, "");
    try {
      await client.createPushConfig(remoteTaskId, {
        url: `${base}/a2a/webhooks/${row.id}/${token}`,
      });
    } catch {
      // Polling always runs, so a push that was refused costs only a delay.
    }
  };

  /**
   * Sends the message, once. The caller won the right to send: it inserted an
   * `auto` row or moved an approved row to SUBMITTED. A timeout is not a
   * failure: the peer may hold the call for minutes (Hermes does), so the task
   * is found by our context and polling goes on.
   */
  const dispatch = async (row: OutboundRow): Promise<OutboundRow> => {
    const connection = await connectionById(row.connectionId);
    if (
      connection?.status !== "active" ||
      connection.outboundPolicy === "off"
    ) {
      return await failLocal(row, "The connection no longer allows sending.");
    }
    const callingRun = await loadRun(db, row.callingRunId, row.workspaceId);
    const hops = callingRun ? callingRun.depth + 1 : 1;
    let prepared: Awaited<ReturnType<typeof clientFor>>;
    try {
      prepared = await clientFor(connection);
    } catch (error) {
      return await failLocal(
        row,
        error instanceof ServiceError
          ? error.message
          : "The peer cannot be called."
      );
    }
    const { client, destination } = prepared;
    await announceSent(row, connection, hops);
    const outcome = await callPeer(client, row, hops);
    if (outcome.kind === "failed") {
      return await failLocal(row, outcome.reason);
    }
    if (outcome.kind !== "task") {
      // No answer in time, or none we can use. Polling finds the task by our context.
      return await touch(row);
    }
    const after = await applyRemote(row, outcome.task);
    if (destination.push && !isTerminal(after.state)) {
      await registerPush(row, client, outcome.task.id);
    }
    return after;
  };

  /** The send is on the record before the call, so a call that hangs still shows. */
  const announceSent = async (
    row: OutboundRow,
    connection: ConnectionRow,
    hops: number
  ): Promise<void> => {
    await db
      .update(a2aConnections)
      .set({ lastOutAt: nowIso() })
      .where(eq(a2aConnections.id, connection.id));
    await record({
      actor: { id: connection.localAgentId, kind: "agent" },
      agentId: connection.localAgentId,
      payload: {
        chars: row.text.length,
        connectionId: connection.id,
        hops,
        outboundTaskId: row.id,
      },
      runId: row.callingRunId,
      sessionId: row.sessionId,
      type: "a2a.message_sent",
      workspaceId: row.workspaceId,
    });
  };

  type SendOutcome =
    | { kind: "failed"; reason: string }
    | { kind: "none" }
    | { kind: "task"; task: Task }
    | { kind: "timeout" };

  /**
   * One `SendMessage`. A plain message answer (no task) becomes a completed
   * task of ours. A timeout is not a failure: the peer may hold the call for
   * minutes (Hermes does).
   */
  const callPeer = async (
    client: Awaited<ReturnType<typeof clientFor>>["client"],
    row: OutboundRow,
    hops: number
  ): Promise<SendOutcome> => {
    try {
      const response = await client.sendMessage({
        configuration: { returnImmediately: true },
        message: messageFor(row, hops),
      });
      if (response.task) {
        return { kind: "task", task: response.task };
      }
      if (response.message) {
        return {
          kind: "task",
          task: {
            artifacts: [
              { artifactId: "answer", parts: response.message.parts },
            ],
            contextId: row.contextId ?? undefined,
            id: row.id,
            status: { state: "TASK_STATE_COMPLETED" },
          },
        };
      }
      return { kind: "none" };
    } catch (error) {
      if (error instanceof A2aClientError && error.kind === "timeout") {
        return { kind: "timeout" };
      }
      return { kind: "failed", reason: sendFailure(error) };
    }
  };

  /** Words for a failed send. The peer's own text is cut and never taken as an instruction. */
  const sendFailure = (error: unknown): string => {
    if (error instanceof A2aClientError) {
      switch (error.kind) {
        case "auth":
          return "The peer refused our credential.";
        case "network":
          return "The peer could not be reached.";
        case "invalid_response":
        case "too_large":
          return "The peer sent an answer we could not read.";
        default:
          return `The peer refused the message: ${capText(error.message, 300)}`;
      }
    }
    return "The message could not be sent.";
  };

  /** Everything a new task must pass before a row is written. */
  const admit = async (
    principal: Principal,
    input: z.output<typeof sendInputSchema>
  ): Promise<{ callingRun: RunRecord; connection: ConnectionRow }> => {
    if (principal.kind !== "run") {
      throw new ForbiddenError(SEND_ACTION);
    }
    if (principal.dryRun) {
      throw new ServiceError("invalid", "A dry run sends nothing.");
    }
    const [connection] = await db
      .select()
      .from(a2aConnections)
      .where(
        and(
          eq(a2aConnections.workspaceId, principal.workspaceId),
          eq(a2aConnections.localAgentId, principal.agentId),
          sql`(${a2aConnections.id} = ${input.connection} or ${a2aConnections.slug} = ${input.connection})`
        )
      )
      .limit(1);
    if (!connection) {
      throw new ServiceError("not_found", "No such connection.");
    }
    authorize(principal, SEND_ACTION, {
      id: connection.id,
      kind: CONNECTION_KIND,
      workspaceId: connection.workspaceId,
    });
    if (connection.peerKind === "a2a_inbound") {
      throw new ServiceError(
        "invalid",
        "This peer calls us and has no address we can call."
      );
    }
    if (connection.status !== "active") {
      throw new ServiceError("conflict", "This connection is not active.");
    }
    if (connection.outboundPolicy === "off") {
      await record({
        actor: { id: connection.localAgentId, kind: "agent" },
        agentId: connection.localAgentId,
        payload: { connectionId: connection.id, reason: "outbound_off" },
        type: "a2a.message_refused",
        workspaceId: connection.workspaceId,
      });
      throw new ServiceError("conflict", "Sending to this peer is turned off.");
    }
    if (!destinationOf(connection)) {
      throw new ServiceError(
        "conflict",
        "This connection's destination is not approved. A person must look at it again."
      );
    }
    const callingRun = await loadRun(
      db,
      principal.runId,
      principal.workspaceId
    );
    if (!callingRun) {
      throw new ServiceError("not_found", "Run not found");
    }
    if (callingRun.depth + 1 > MAX_RUN_DEPTH) {
      await record({
        actor: { id: connection.localAgentId, kind: "agent" },
        agentId: connection.localAgentId,
        payload: {
          connectionId: connection.id,
          hops: callingRun.depth + 1,
          reason: "hops",
        },
        type: "a2a.message_refused",
        workspaceId: connection.workspaceId,
      });
      throw new ServiceError(
        "invalid",
        `This message has passed through more than ${MAX_RUN_DEPTH} agents, so it is refused to stop a loop.`
      );
    }
    return { callingRun, connection };
  };

  const byRequestId = async (
    connectionId: string,
    requestId: string
  ): Promise<OutboundRow | null> => {
    const [row] = await db
      .select()
      .from(a2aOutboundTasks)
      .where(
        and(
          eq(a2aOutboundTasks.connectionId, connectionId),
          eq(a2aOutboundTasks.requestId, requestId)
        )
      )
      .limit(1);
    return row ?? null;
  };

  /**
   * The insert of a task. It only lands while no row has this `requestId`,
   * the connection is still active and it is under its hourly limit, all
   * counted in the one statement, so two sends at once cannot both win.
   */
  const insertGuarded = (
    row: typeof a2aOutboundTasks.$inferInsert,
    connection: ConnectionRow
  ) => {
    const since = new Date(clock.now().getTime() - HOUR_MS).toISOString();
    return db
      .insert(a2aOutboundTasks)
      .select(
        db
          .select({
            callingRunId: sql<string>`${row.callingRunId}`.as("callingRunId"),
            connectionId: sql<string>`${row.connectionId}`.as("connectionId"),
            contextId: sql<string | null>`${row.contextId ?? null}`.as(
              "contextId"
            ),
            createdAt: sql<string>`${row.createdAt}`.as("createdAt"),
            id: sql<string>`${row.id}`.as("id"),
            nextPollAt: sql<string | null>`${row.nextPollAt ?? null}`.as(
              "nextPollAt"
            ),
            pollUntil: sql<string | null>`${row.pollUntil ?? null}`.as(
              "pollUntil"
            ),
            remoteTaskId: sql<string | null>`${null}`.as("remoteTaskId"),
            requestId: sql<string | null>`${row.requestId ?? null}`.as(
              "requestId"
            ),
            resultReadAt: sql<string | null>`${null}`.as("resultReadAt"),
            resultText: sql<string | null>`${null}`.as("resultText"),
            sessionId: sql<string>`${row.sessionId}`.as("sessionId"),
            state: sql<string>`${row.state}`.as("state"),
            text: sql<string>`${row.text}`.as("text"),
            updatedAt: sql<string>`${row.updatedAt}`.as("updatedAt"),
            webhookTokenHash: sql<
              string | null
            >`${row.webhookTokenHash ?? null}`.as("webhookTokenHash"),
            workspaceId: sql<string>`${row.workspaceId}`.as("workspaceId"),
          })
          .from(sql`(select 1)`)
          .where(
            sql`exists (select 1 from ${a2aConnections} where ${a2aConnections.id} = ${connection.id} and ${a2aConnections.status} = 'active') and not exists (select 1 from ${a2aOutboundTasks} where ${a2aOutboundTasks.connectionId} = ${connection.id} and ${a2aOutboundTasks.requestId} = ${row.requestId ?? ""}) and ${hourlyCountSql(connection.id, since)} < ${connection.hourlyLimit}`
          )
      )
      .returning({ id: a2aOutboundTasks.id });
  };

  const refuseFull = async (connection: ConnectionRow): Promise<never> => {
    const { oldest, used } = await hourlyUse(db, clock, connection.id);
    if (used < connection.hourlyLimit) {
      throw new ServiceError("conflict", "This connection is not active.");
    }
    const freeAt =
      (oldest ? Date.parse(oldest) : clock.now().getTime()) + HOUR_MS;
    const retryAfterSeconds = Math.max(
      Math.ceil((freeAt - clock.now().getTime()) / 1000),
      1
    );
    await record({
      actor: { id: connection.localAgentId, kind: "agent" },
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

  /** What a person sees on the approval card: the peer, where it lives and the whole text. */
  const cardInput = (connection: ConnectionRow, text: string) => ({
    connection: connection.slug,
    host: hostOf(connection.peerOrigin),
    peer: peerName(connection),
    text,
  });

  /** Writes the task row, or hands back the one a send of the same `requestId` made a moment ago. */
  const createTask = async ({
    approve,
    callingRun,
    connection,
    input,
  }: {
    approve: boolean;
    callingRun: RunRecord;
    connection: ConnectionRow;
    input: z.output<typeof sendInputSchema>;
  }): Promise<{ id: string } | { winner: OutboundRow }> => {
    const id = `aot_${ulid(clock.now().getTime())}`;
    const token = await webhookToken(id);
    const now = nowIso();
    const inserted = await insertGuarded(
      {
        callingRunId: callingRun.id,
        connectionId: connection.id,
        contextId: `hm-${id}`,
        createdAt: now,
        id,
        nextPollAt: approve ? null : later(FAST_POLL_MS),
        pollUntil: approve ? null : later(POLL_WINDOW_MS),
        requestId: input.requestId,
        sessionId: callingRun.sessionId,
        state: approve ? "TASK_STATE_AUTH_REQUIRED" : "TASK_STATE_SUBMITTED",
        text: input.text,
        updatedAt: now,
        webhookTokenHash: token ? await hashToken(token) : null,
        workspaceId: connection.workspaceId,
      },
      connection
    );
    if (inserted.length > 0) {
      return { id };
    }
    const winner = await byRequestId(connection.id, input.requestId);
    return winner ? { winner } : await refuseFull(connection);
  };

  /**
   * Sends a message to a peer, or recalls the task an earlier call with the
   * same `requestId` made. With `approve` nothing is sent until a person
   * answers the card, and the card holds the full text.
   */
  const send = async (
    principal: Principal,
    rawInput: SendInput
  ): Promise<OutboundTaskInfo> => {
    const input = sendInputSchema.parse(rawInput);
    const { callingRun, connection } = await admit(principal, input);
    const earlier = await byRequestId(connection.id, input.requestId);
    if (earlier) {
      return await view(earlier);
    }
    const approve = connection.outboundPolicy === "approve";
    const card = cardInput(connection, input.text);
    if (approve && capInput(card) !== card) {
      throw new ServiceError(
        "invalid",
        "This message is too long to show a person for approval. Shorten it."
      );
    }
    const created = await createTask({
      approve,
      callingRun,
      connection,
      input,
    });
    if ("winner" in created) {
      return await view(created.winner);
    }
    const { id } = created;
    const row = await requireTask(id);
    if (!approve) {
      return await view(await dispatch(row));
    }
    try {
      await requests.open(SYSTEM_PRINCIPAL, {
        input: card,
        kind: "approval",
        runId: callingRun.id,
        toolKey: `${A2A_SEND_TOOL}:${connection.id}`,
        toolName: A2A_SEND_TOOL,
        toolUseId: `a2a:${id}`,
      });
    } catch (error) {
      await failLocal(row, "No approval could be asked for this message.");
      throw error;
    }
    return await view(row);
  };

  // ---------------------------------------------------------------------
  // Reading

  /**
   * The task in the shape `get_run` answers. It asks the peer again when the
   * row is a few seconds old. A terminal result an agent reads is marked read,
   * so no wake repeats it.
   */
  const get = async (
    principal: Principal,
    taskId: string
  ): Promise<OutboundTaskInfo> => {
    const row = await requireTask(taskId);
    const connection = await connectionById(row.connectionId);
    if (!connection) {
      throw new ServiceError("not_found", "Task not found");
    }
    requireOwnRun(principal, connection, READ_ACTION);
    let current = row;
    const stale =
      clock.now().getTime() - Date.parse(row.updatedAt) > GET_REFRESH_MS;
    if (!isTerminal(row.state) && row.nextPollAt !== null && stale) {
      current = await refresh(row);
    }
    if (principal.kind === "run" && isTerminal(current.state)) {
      await db
        .update(a2aOutboundTasks)
        .set({ resultReadAt: nowIso() })
        .where(
          and(
            eq(a2aOutboundTasks.id, current.id),
            isNull(a2aOutboundTasks.resultReadAt)
          )
        );
    }
    return infoOf(current, connection.localAgentId);
  };

  // ---------------------------------------------------------------------
  // The webhook

  /**
   * A push for a task. The token in the path is the only thing checked, and
   * the body is never read: the real state comes from `GetTask` with our own
   * credential. Wrong token, an unknown task and a connection that is no
   * longer active all answer the same, so the answer says nothing about which.
   */
  const nudge = async (
    taskId: string,
    token: string
  ): Promise<{ ok: boolean }> => {
    const row = await taskById(taskId);
    const connection = row ? await connectionById(row.connectionId) : null;
    if (
      !(row?.webhookTokenHash && connection) ||
      connection.status !== "active" ||
      !(await tokenMatchesHash(token, row.webhookTokenHash))
    ) {
      return { ok: false };
    }
    if (row.remoteTaskId !== null) {
      await refresh(row);
    }
    return { ok: true };
  };

  // ---------------------------------------------------------------------
  // The tick

  const inChunks = async <T>(
    items: readonly T[],
    work: (item: T) => Promise<unknown>
  ): Promise<void> => {
    for (let index = 0; index < items.length; index += CONCURRENCY) {
      // biome-ignore lint/performance/noAwaitInLoops: a small fixed concurrency keeps one tick short
      await Promise.all(
        items.slice(index, index + CONCURRENCY).map(async (item) => {
          try {
            await work(item);
          } catch (error) {
            console.error("A2A outbound task failed", error);
          }
        })
      );
    }
  };

  /** Polls the tasks that are due, a bounded batch at a time. Each is claimed first, so two ticks do not poll one task twice. */
  const pollDue = async (principal: Principal): Promise<number> => {
    if (principal.kind !== "system") {
      throw new ForbiddenError(READ_ACTION);
    }
    const due = await db
      .select()
      .from(a2aOutboundTasks)
      .where(
        and(
          lte(a2aOutboundTasks.nextPollAt, nowIso()),
          sql`${a2aOutboundTasks.state} not in ('TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED')`
        )
      )
      .orderBy(asc(a2aOutboundTasks.nextPollAt))
      .limit(POLL_BATCH);
    let polled = 0;
    await inChunks(due, async (row) => {
      const [claimed] = await db
        .update(a2aOutboundTasks)
        .set({ nextPollAt: later(MINUTE_MS) })
        .where(
          and(
            eq(a2aOutboundTasks.id, row.id),
            eq(a2aOutboundTasks.nextPollAt, row.nextPollAt ?? "")
          )
        )
        .returning();
      if (!claimed) {
        return;
      }
      polled += 1;
      if (claimed.pollUntil !== null && claimed.pollUntil <= nowIso()) {
        await failLocal(
          claimed,
          "No answer from the peer in 24 hours, so we stopped waiting."
        );
        return;
      }
      await refresh(claimed);
    });
    return polled;
  };

  // ---------------------------------------------------------------------
  // Approvals

  /** The approval request behind a task, when it has been answered. */
  const settledRequest = async (row: OutboundRow) => {
    const [request] = await db
      .select()
      .from(runRequests)
      .where(
        and(
          eq(runRequests.workspaceId, row.workspaceId),
          eq(runRequests.toolName, A2A_SEND_TOOL),
          eq(runRequests.toolUseId, `a2a:${row.id}`)
        )
      )
      .limit(1);
    return request && request.status !== "pending" ? request : null;
  };

  const approved = (answer: string | null): boolean => {
    try {
      const { decision } = JSON.parse(answer ?? "{}") as { decision?: string };
      return decision === "allow_once" || decision === "always_allow";
    } catch {
      return false;
    }
  };

  type SettledRequest = NonNullable<Awaited<ReturnType<typeof settledRequest>>>;

  const deciderOf = (request: SettledRequest) =>
    request.answeredBy
      ? ({ id: request.answeredBy, kind: "user" } as const)
      : SYSTEM_ACTOR;

  /** A person said no, or nobody answered in time. Nothing was sent, and the agent reads why with `get`. */
  const declineSend = async (
    row: OutboundRow,
    connection: ConnectionRow,
    request: SettledRequest
  ): Promise<void> => {
    const answered = request.status === "answered";
    const [declined] = await db
      .update(a2aOutboundTasks)
      .set({
        nextPollAt: null,
        resultReadAt: nowIso(),
        resultText: answered
          ? "A person declined to send this message."
          : "Nobody answered in time, so the message was not sent.",
        state: "TASK_STATE_REJECTED",
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(a2aOutboundTasks.id, row.id),
          eq(a2aOutboundTasks.state, "TASK_STATE_AUTH_REQUIRED")
        )
      )
      .returning();
    if (declined) {
      await record({
        actor: deciderOf(request),
        agentId: connection.localAgentId,
        payload: {
          answered,
          connectionId: connection.id,
          outboundTaskId: row.id,
        },
        sessionId: row.sessionId,
        type: "a2a.message_declined",
        workspaceId: row.workspaceId,
      });
    }
  };

  /** A person said yes. The row moves by compare-and-set, and only the call that moved it sends. */
  const sendApproved = async (
    row: OutboundRow,
    connection: ConnectionRow,
    request: SettledRequest
  ): Promise<void> => {
    const [won] = await db
      .update(a2aOutboundTasks)
      .set({
        nextPollAt: later(FAST_POLL_MS),
        pollUntil: later(POLL_WINDOW_MS),
        state: "TASK_STATE_SUBMITTED",
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(a2aOutboundTasks.id, row.id),
          eq(a2aOutboundTasks.state, "TASK_STATE_AUTH_REQUIRED"),
          isNull(a2aOutboundTasks.remoteTaskId)
        )
      )
      .returning();
    if (!won) {
      return;
    }
    await record({
      actor: deciderOf(request),
      agentId: connection.localAgentId,
      payload: { connectionId: connection.id, outboundTaskId: row.id },
      sessionId: row.sessionId,
      type: "a2a.message_approved",
      workspaceId: row.workspaceId,
    });
    await dispatch(won);
  };

  /**
   * Acts on a person's answer to the card. The state moves from
   * AUTH_REQUIRED by compare-and-set, so the answer's event and the tick
   * cannot both send, and an approval after a revoke sends nothing.
   */
  const settleApproval = async (row: OutboundRow): Promise<void> => {
    if (row.state !== "TASK_STATE_AUTH_REQUIRED" || row.remoteTaskId !== null) {
      return;
    }
    const request = await settledRequest(row);
    const connection = request ? await connectionById(row.connectionId) : null;
    if (!(request && connection)) {
      return;
    }
    if (request.status === "answered" && approved(request.answer)) {
      await sendApproved(row, connection, request);
      return;
    }
    await declineSend(row, connection, request);
  };

  /** The answer to a card arrives as an event. Failures are the tick's to retry. */
  const onEvent = async (event: {
    payload: Record<string, unknown>;
    type: string;
  }): Promise<void> => {
    const { requestId } = event.payload;
    if (event.type !== "request.answered" || typeof requestId !== "string") {
      return;
    }
    const [request] = await db
      .select({
        toolName: runRequests.toolName,
        toolUseId: runRequests.toolUseId,
      })
      .from(runRequests)
      .where(eq(runRequests.id, requestId))
      .limit(1);
    if (
      request?.toolName !== A2A_SEND_TOOL ||
      !request.toolUseId.startsWith("a2a:")
    ) {
      return;
    }
    try {
      const row = await taskById(request.toolUseId.slice("a2a:".length));
      if (row) {
        await settleApproval(row);
      }
    } catch (error) {
      console.error("A2A outbound approval failed", error);
    }
  };

  /** Settles cards that were answered or expired without the event reaching us. */
  const settleApprovals = async (principal: Principal): Promise<number> => {
    if (principal.kind !== "system") {
      throw new ForbiddenError(READ_ACTION);
    }
    const waiting = await db
      .select()
      .from(a2aOutboundTasks)
      .where(
        and(
          eq(a2aOutboundTasks.state, "TASK_STATE_AUTH_REQUIRED"),
          isNull(a2aOutboundTasks.remoteTaskId)
        )
      )
      .orderBy(asc(a2aOutboundTasks.createdAt))
      .limit(SETTLE_BATCH);
    await inChunks(waiting, settleApproval);
    return waiting.length;
  };

  // ---------------------------------------------------------------------
  // Wakes

  const sessionOrigin = async (sessionId: string) => {
    const [session] = await db
      .select({ origin: sessions.origin })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return session?.origin;
  };

  const answerText = (row: OutboundRow, connection: ConnectionRow): string => {
    const name = peerName(connection);
    const asked = capText(row.text, 160);
    const body =
      row.state === "TASK_STATE_COMPLETED"
        ? (row.resultText ?? "")
        : `The task ended as ${row.state.replace("TASK_STATE_", "").toLowerCase()}. ${row.resultText ?? ""}`.trim();
    return `${name} answered your earlier message "${asked}":\n\n${body}`;
  };

  /**
   * Starts the follow-up run for a result the agent has not read, when the
   * calling run is over. It happens once: the compare-and-set on
   * `result_read_at` decides, and a failed start gives the claim back. A wake
   * counts against the hourly limit, so one that would pass it waits for the
   * next tick. The reply target is the calling run's, except that an answer to
   * a peer's task is not sent a second time.
   */
  const wake = async (row: OutboundRow): Promise<boolean> => {
    if (row.resultReadAt !== null || !WAKE_STATES.includes(row.state)) {
      return false;
    }
    const connection = await connectionById(row.connectionId);
    const callingRun = await loadRun(db, row.callingRunId, row.workspaceId);
    if (
      !(
        connection &&
        callingRun &&
        TERMINAL_STATUSES.includes(callingRun.status)
      )
    ) {
      return false;
    }
    const { used } = await hourlyUse(db, clock, connection.id);
    if (used >= connection.hourlyLimit) {
      return false;
    }
    const claimedAt = nowIso();
    const [claimed] = await db
      .update(a2aOutboundTasks)
      .set({ resultReadAt: claimedAt })
      .where(
        and(
          eq(a2aOutboundTasks.id, row.id),
          isNull(a2aOutboundTasks.resultReadAt)
        )
      )
      .returning({ id: a2aOutboundTasks.id });
    if (!claimed) {
      return false;
    }
    try {
      await startWakeRun(row, connection, callingRun);
      return true;
    } catch (error) {
      // The start did not land, so the claim goes back for the next tick.
      // The run's `requestId` is the task's, so a start that did land is not repeated.
      await db
        .update(a2aOutboundTasks)
        .set({ resultReadAt: null })
        .where(
          and(
            eq(a2aOutboundTasks.id, row.id),
            eq(a2aOutboundTasks.resultReadAt, claimedAt)
          )
        );
      console.error("A2A wake failed", error);
      return false;
    }
  };

  /** The follow-up run: the same session, the calling run's reply target, the answer in the peer envelope. */
  const startWakeRun = async (
    row: OutboundRow,
    connection: ConnectionRow,
    callingRun: RunRecord
  ): Promise<void> => {
    const origin = await sessionOrigin(row.sessionId);
    if (!origin) {
      throw new ServiceError("not_found", "Session not found");
    }
    const started = await runs.startRun(
      SYSTEM_PRINCIPAL,
      {
        agentId: callingRun.agentId,
        input: {
          text: buildPeerEnvelope(
            {
              agentName: peerName(connection),
              connectionId: connection.id,
              host: hostOf(connection.peerOrigin),
            },
            answerText(row, connection)
          ),
        },
        reply:
          callingRun.reply.kind === "a2a" ? { kind: "none" } : callingRun.reply,
        requestId: `a2a-wake:${row.id}`,
        session: { origin: origin as StartRunInput["session"]["origin"] },
      },
      { sessionId: row.sessionId }
    );
    await record({
      actor: { id: connection.id, kind: "peer" },
      agentId: connection.localAgentId,
      payload: {
        connectionId: connection.id,
        outboundTaskId: row.id,
        woke: true,
      },
      runId: started.runId,
      sessionId: row.sessionId,
      type: "a2a.result_received",
      workspaceId: row.workspaceId,
    });
  };

  /** The tick's wakes: unread results on runs that have ended, from the last day. */
  const wakeDue = async (principal: Principal): Promise<number> => {
    if (principal.kind !== "system") {
      throw new ForbiddenError(READ_ACTION);
    }
    const unread = await db
      .select()
      .from(a2aOutboundTasks)
      .where(
        and(
          isNull(a2aOutboundTasks.resultReadAt),
          inArray(a2aOutboundTasks.state, [...WAKE_STATES]),
          sql`${a2aOutboundTasks.updatedAt} > ${new Date(clock.now().getTime() - DAY_MS).toISOString()}`
        )
      )
      .orderBy(asc(a2aOutboundTasks.updatedAt))
      .limit(WAKE_BATCH);
    let woken = 0;
    await inChunks(unread, async (row) => {
      if (await wake(row)) {
        woken += 1;
      }
    });
    return woken;
  };

  /** A revoked connection fails its open tasks locally and wakes nothing. */
  const onConnectionRevoked = async (revoked: {
    connectionId: string;
  }): Promise<void> => {
    await db
      .update(a2aOutboundTasks)
      .set({
        nextPollAt: null,
        resultReadAt: nowIso(),
        resultText: "The connection was revoked.",
        state: "TASK_STATE_FAILED",
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(a2aOutboundTasks.connectionId, revoked.connectionId),
          sql`${a2aOutboundTasks.state} not in ('TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED')`
        )
      );
  };

  return {
    get,
    nudge,
    onConnectionRevoked,
    onEvent,
    pollDue,
    send,
    settleApprovals,
    wakeDue,
  };
};

export type OutboundService = ReturnType<typeof createOutboundService>;
