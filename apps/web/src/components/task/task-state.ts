// The live state of a task view (V2.11). It starts from `tasks.get` and folds
// in the frames of the session stream, so the receipt and the action log can
// be rebuilt from the event list on each event, without fetching the run
// again. Pure: `use-session-events.ts` owns the EventSource, and the page owns
// the reducer. Follows the fold rules of the chat's old stream reducer (V1.6).

import type { EventType, RunStatus } from "@repo/db/shared";
import type { EventFrame, StreamFrame } from "@repo/protocol/stream";
import type { EventRecord } from "@repo/services/events";
import {
  type RequestView,
  type Settled,
  settledFromEvent,
  viewFromOpened,
  viewFromRecord,
} from "#/components/requests/request-card-logic.ts";
import type { TaskView } from "#/integrations/trpc/types";

/** A pending request as `tasks.get` and `requests.pending` return it. */
export type RequestSource = Parameters<typeof viewFromRecord>[0];

export interface TaskLive {
  events: EventRecord[];
  /** True when a request frame named one the page does not know, so the pending ones should be fetched. */
  needsRequests: boolean;
  /** Requests fetched from the server, for ones whose `request.opened` payload is not in the events. */
  records: RequestSource[];
  runId: string;
  runStatus: RunStatus;
  sessionId: string;
  /** Requests settled by this browser's own answer, by request id. */
  settled: Readonly<Record<string, Settled>>;
}

/** The run status an event moves its run to. Mirrors the server's table in `session-stream-frames.ts`. */
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

const ACTIVE: readonly RunStatus[] = [
  "queued",
  "offered",
  "running",
  "waiting",
];

/** True while the run can still change. */
export const isActive = (status: RunStatus): boolean => ACTIVE.includes(status);

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : 1;

export const initialLive = (task: TaskView): TaskLive => ({
  events: task.events,
  needsRequests: false,
  records: task.request === null ? [] : [task.request],
  runId: task.run.id,
  runStatus: task.run.status,
  sessionId: task.session.id,
  settled: {},
});

/** The id of the newest event the page has, where the stream resumes from. Event ids sort by time. */
export const lastEventId = (live: TaskLive): string | null =>
  live.events.at(-1)?.id ?? null;

/** The event a frame carries, as the stored record the receipt reads. A payload that went to R2 reads empty, as it does in the stored row. */
export const recordOf = (
  frame: EventFrame,
  sessionId: string
): EventRecord => ({
  actor: frame.actor,
  agentId: null,
  createdAt: frame.createdAt,
  id: frame.id,
  payload: "truncated" in frame ? {} : frame.payload,
  payloadRef: "truncated" in frame ? "truncated" : null,
  runId: frame.runId,
  seq: frame.seq,
  sessionId,
  type: frame.type,
  workspaceId: "",
});

/** The events with `record` among them, in id order. A known id changes nothing. */
const withEvent = (
  events: EventRecord[],
  record: EventRecord
): EventRecord[] => {
  if (events.some(({ id }) => id === record.id)) {
    return events;
  }
  const last = events.at(-1);
  return last === undefined || last.id < record.id
    ? [...events, record]
    : [...events, record].sort(byId);
};

const statusAfter = (
  status: RunStatus,
  events: readonly EventRecord[],
  runId: string
): RunStatus =>
  events.reduce<RunStatus>(
    (current, event) =>
      event.runId === runId ? (RUN_STATUS_OF[event.type] ?? current) : current,
    status
  );

/**
 * The requests of this run, by request id: the ones in `request.opened`
 * events and the fetched records, each settled by its `request.answered`,
 * `request.expired` or `request.cancelled` event, else by this browser's own
 * answer.
 */
export const requestViews = (live: TaskLive): Map<string, RequestView> => {
  const views = new Map<string, RequestView>();
  for (const record of live.records) {
    const view = viewFromRecord(record, null);
    if (view !== null && view.runId === live.runId) {
      views.set(view.id, view);
    }
  }
  const settledBy = new Map<string, Settled>();
  for (const event of live.events) {
    if (event.type === "request.opened" && event.runId === live.runId) {
      const view = viewFromOpened(event.payload, event.runId, null);
      if (view !== null) {
        views.set(view.id, view);
      }
    } else if (event.type.startsWith("request.")) {
      const settled = settledFromEvent(event.type, event.payload);
      if (settled !== null && typeof event.payload.requestId === "string") {
        settledBy.set(event.payload.requestId, settled);
      }
    }
  }
  for (const [id, view] of views) {
    views.set(id, {
      ...view,
      settled: settledBy.get(id) ?? live.settled[id] ?? null,
    });
  }
  return views;
};

/** The events of this run, which the receipt and the log are built from. */
export const runEvents = (live: TaskLive): EventRecord[] =>
  live.events.filter((event) => event.runId === live.runId);

/** A fresh `tasks.get`. Events that reached the stream while it was in flight, and are newer, are kept. */
export const applyTask = (live: TaskLive, task: TaskView): TaskLive => {
  const fetchedLast = task.events.at(-1)?.id;
  const newer =
    fetchedLast === undefined
      ? live.events
      : live.events.filter((event) => event.id > fetchedLast);
  return {
    ...live,
    events: [...task.events, ...newer],
    needsRequests: false,
    records: task.request === null ? [] : [task.request],
    runStatus: statusAfter(task.run.status, newer, live.runId),
  };
};

const applyEvent = (live: TaskLive, frame: EventFrame): TaskLive => {
  const events = withEvent(live.events, recordOf(frame, live.sessionId));
  const status =
    frame.runId === live.runId ? RUN_STATUS_OF[frame.type] : undefined;
  return {
    ...live,
    events,
    runStatus: status ?? live.runStatus,
  };
};

/** One frame of the session stream. Frames of other runs only add their events. */
export const applyFrame = (live: TaskLive, frame: StreamFrame): TaskLive => {
  switch (frame.frame) {
    case "event":
      return applyEvent(live, frame);
    case "run":
      return frame.runId === live.runId
        ? { ...live, runStatus: frame.status }
        : live;
    case "request":
      // The `request.opened` event that follows carries the card. This shows
      // it a moment sooner, and covers an opened event whose payload was cut.
      return frame.runId === live.runId &&
        frame.status === "pending" &&
        !requestViews(live).has(frame.requestId)
        ? { ...live, needsRequests: true }
        : live;
    default:
      return live;
  }
};

/** The pending requests of a fetch. */
export const applyPending = (
  live: TaskLive,
  records: RequestSource[]
): TaskLive => ({ ...live, needsRequests: false, records });

/** A request settled by this browser's own answer. */
export const applySettled = (
  live: TaskLive,
  requestId: string,
  settled: Settled
): TaskLive => ({
  ...live,
  settled: { ...live.settled, [requestId]: settled },
});
