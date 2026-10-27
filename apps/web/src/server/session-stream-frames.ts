// How a stored event becomes stream frames. Shared by the publisher (live
// frames) and the SSE route (replay from D1), so both send the same thing.
// The record is the stored one: the secret strip, the C.19 tool scrub and the
// run's masker have already run, so nothing raw is streamed from here.
import type { EventType, RunStatus } from "@repo/db/shared";
import type { RunFrame, StreamFrame } from "@repo/protocol/stream";
import type { EventRecord } from "@repo/services/events";

/**
 * The event types a session stream carries, replayed and live. The replay
 * query takes exact types, so this list is the filter and the live gate both.
 */
export const STREAM_EVENT_TYPES = [
  "message.user",
  "message.assistant",
  "message.reasoning",
  "tool.call",
  "tool.result",
  "artifact.published",
  "run.queued",
  "run.started",
  "run.waiting",
  "run.resumed",
  "run.finished",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
  "run.dry_run_skipped",
  "run.limit_reached",
  "run.repeat_stopped",
  "request.opened",
  "request.answered",
  "request.expired",
  "request.cancelled",
  "mail.failed",
  "qa.asked",
  "qa.answered",
] as const satisfies readonly EventType[];

/**
 * The event types the task view shows: the stream's, plus the connector
 * outcomes its action log lists. They stay out of `STREAM_EVENT_TYPES`, which
 * is also the live gate and the replay filter.
 */
export const TASK_EVENT_TYPES = [
  ...STREAM_EVENT_TYPES,
  "connector.call",
  "connector.needs_auth",
  "connector.timeout",
] as const satisfies readonly EventType[];

const STREAM_TYPES: ReadonlySet<EventType> = new Set(STREAM_EVENT_TYPES);

/** The event types the desk stream carries: requests and runs, not messages, tool calls or dry-run skips. */
export const DESK_EVENT_TYPES = STREAM_EVENT_TYPES.filter(
  (type) =>
    (type.startsWith("request.") || type.startsWith("run.")) &&
    type !== "run.dry_run_skipped"
);

/** The name of the one SessionStream Durable Object per workspace that carries the desk frames. */
export const deskStreamName = (workspaceId: string): string =>
  `desk:${workspaceId}`;

/** The run status an event moves its run to. `run.limit_reached` and `run.repeat_stopped` are followed by `run.failed`. */
const RUN_STATUS_OF: Partial<Record<EventType, RunStatus>> = {
  "run.cancelled": "cancelled",
  "run.failed": "failed",
  "run.finished": "done",
  "run.interrupted": "interrupted",
  "run.queued": "queued",
  "run.resumed": "running",
  "run.started": "running",
  "run.waiting": "waiting",
};

/** The `event` frame of a stored event. A payload that went to R2 is not sent, only marked `truncated`. */
export const eventFrame = (record: EventRecord): StreamFrame => {
  const fields = {
    actor: record.actor,
    ...(record.actorDisplay
      ? { actorDisplay: { name: record.actorDisplay.name } }
      : {}),
    createdAt: record.createdAt,
    frame: "event" as const,
    id: record.id,
    runId: record.runId,
    seq: record.seq,
    type: record.type,
  };
  return record.payloadRef === null
    ? { ...fields, payload: record.payload }
    : { ...fields, truncated: true };
};

/** The frames to publish for a stored event: the event itself, then a `run` frame when it changes the run's status. Empty for an event outside a session or a type the stream does not carry. */
export const framesOf = (record: EventRecord): StreamFrame[] => {
  if (record.sessionId === null || !STREAM_TYPES.has(record.type)) {
    return [];
  }
  const status = RUN_STATUS_OF[record.type];
  const frames: StreamFrame[] = [eventFrame(record)];
  if (status !== undefined && record.runId !== null) {
    const run: RunFrame = { frame: "run", runId: record.runId, status };
    frames.push(run);
  }
  return frames;
};
