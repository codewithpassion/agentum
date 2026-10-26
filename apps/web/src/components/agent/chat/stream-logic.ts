// The chat's view of a session stream (V1.6). `applyFrame` folds the frames of
// `GET /api/sessions/:sessionId/stream` into the transcript the chat shows, so
// `toChatItems` reads the same list whether it came from a fetch or the stream.
// Pure: the hook owns the EventSource and the fetches.

import type { EventType, RunStatus } from "@repo/db/shared";
import { stripAttachmentMarkers } from "@repo/protocol/attachments";
import {
  type DeltaFrame,
  type EventFrame,
  type StreamFrame,
  streamFrameSchema,
} from "@repo/protocol/stream";
import {
  type RequestView,
  type Settled,
  settledFromEvent,
  viewFromOpened,
  viewFromRecord,
} from "#/components/requests/request-card-logic.ts";
import type { SessionTranscript } from "#/integrations/trpc/types";
import {
  type ChatEntry,
  type ChatItem,
  isRunActive,
  toChatItems,
} from "./chat-logic.ts";

export type ChatTranscript = Omit<SessionTranscript, "entries"> & {
  entries: ChatEntry[];
};

/** The partial assistant message of a run, replaced by its stored event. */
interface Delta {
  messageKey: string;
  text: string;
}

export interface StreamState {
  /** Partial assistant messages by run id. */
  deltas: Readonly<Record<string, Delta>>;
  /** Message keys whose stored event is in, so a late delta for them is dropped. */
  finishedKeys: readonly string[];
  /** True when the stream cannot show something and the transcript should be fetched again. */
  needsRefetch: boolean;
  /** True when a request showed up that the chat does not know, so the pending ones should be fetched. */
  needsRequests: boolean;
  /** The requests the chat shows, pending or settled, oldest first. */
  requests: readonly RequestView[];
  transcript: ChatTranscript;
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

const isChatEvent = (type: EventType): boolean =>
  type.startsWith("message.") || type.startsWith("tool.");

/** The frame JSON of one SSE message, or null when it is not a frame we know. */
export const parseFrame = (data: string): StreamFrame | null => {
  try {
    const parsed = streamFrameSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const initialState = (transcript: ChatTranscript): StreamState => ({
  deltas: {},
  finishedKeys: [],
  needsRefetch: false,
  needsRequests: false,
  requests: [],
  transcript,
});

/** The id of the last stored event in the transcript, where the stream resumes from. */
export const lastEntryId = (transcript: ChatTranscript): string | null =>
  transcript.entries.at(-1)?.id ?? null;

/**
 * A freshly fetched transcript. Events that reached the stream while the fetch
 * was in flight, and are newer than the fetched ones, are kept. Event ids sort
 * by time, so a string comparison tells which is newer.
 */
export const applyTranscript = (
  state: StreamState | null,
  transcript: ChatTranscript
): StreamState => {
  if (state === null) {
    return initialState(transcript);
  }
  const lastId = lastEntryId(transcript);
  const newer =
    lastId === null
      ? state.transcript.entries
      : state.transcript.entries.filter((entry) => entry.id > lastId);
  const { latestRun } = transcript;
  const entries = [...transcript.entries, ...newer];
  const kept =
    latestRun !== null && isRunActive(latestRun.status)
      ? Object.entries(state.deltas).filter(
          ([runId, delta]) =>
            runId === latestRun.id && !isStored(entries, runId, delta.text)
        )
      : [];
  const finished = Object.entries(state.deltas)
    .filter(([runId]) => !kept.some(([keptId]) => keptId === runId))
    .map(([, delta]) => delta.messageKey);
  return {
    ...state,
    deltas: Object.fromEntries(kept),
    finishedKeys: [...state.finishedKeys, ...finished],
    needsRefetch: false,
    transcript: { ...transcript, entries },
  };
};

/** True when the run's last stored assistant message already holds this partial text. */
const isStored = (
  entries: readonly ChatEntry[],
  runId: string,
  text: string
): boolean => {
  const last = entries.findLast(
    (entry) => entry.type === "message.assistant" && entry.runId === runId
  );
  const stored = last?.payload.text;
  return typeof stored === "string" && stored.startsWith(text);
};

const withRunStatus = (
  state: StreamState,
  runId: string,
  status: RunStatus
): StreamState => {
  const { latestRun } = state.transcript;
  if (latestRun?.id !== runId) {
    // A run this transcript has not seen: its details come with a fetch.
    return { ...state, needsRefetch: true };
  }
  if (latestRun.status === status) {
    return state;
  }
  // A finished run's error, files and end time are not in the frame.
  const needsRefetch = state.needsRefetch || !isRunActive(status);
  return {
    ...state,
    needsRefetch,
    transcript: { ...state.transcript, latestRun: { ...latestRun, status } },
  };
};

const withoutDelta = (
  deltas: StreamState["deltas"],
  runId: string | null
): StreamState["deltas"] => {
  if (runId === null || !(runId in deltas)) {
    return deltas;
  }
  const { [runId]: _removed, ...rest } = deltas;
  return rest;
};

/** The id of the last entry of the run, where a request of that run is shown after. */
const anchorOf = (
  entries: readonly ChatEntry[],
  runId: string | null
): string | null =>
  runId === null
    ? null
    : (entries.findLast((entry) => entry.runId === runId)?.id ?? null);

/** True when a request's line may still be replaced by a better one. */
const isOpen = (view: RequestView): boolean =>
  view.settled === null || view.settled.status === "conflict";

const settleRequest = (
  state: StreamState,
  requestId: string,
  settled: Settled
): StreamState => {
  const known = state.requests.find((view) => view.id === requestId);
  if (known === undefined || !isOpen(known)) {
    return state;
  }
  return {
    ...state,
    requests: state.requests.map((view) =>
      view.id === requestId ? { ...view, settled } : view
    ),
  };
};

const applyRequestEvent = (
  state: StreamState,
  frame: EventFrame
): StreamState => {
  if ("truncated" in frame) {
    return state;
  }
  const { payload, runId, type } = frame;
  if (type === "request.opened") {
    const view = viewFromOpened(
      payload,
      runId,
      anchorOf(state.transcript.entries, runId)
    );
    return view === null || state.requests.some(({ id }) => id === view.id)
      ? state
      : { ...state, requests: [...state.requests, view] };
  }
  const settled = settledFromEvent(type, payload);
  return settled === null || typeof payload.requestId !== "string"
    ? state
    : settleRequest(state, payload.requestId, settled);
};

const applyEvent = (state: StreamState, frame: EventFrame): StreamState => {
  if (frame.type.startsWith("request.")) {
    return applyRequestEvent(state, frame);
  }
  if ("truncated" in frame) {
    // The payload is not in the frame: fetch the transcript to read it.
    return state.needsRefetch ? state : { ...state, needsRefetch: true };
  }
  const { entries } = state.transcript;
  let next = state;
  if (
    isChatEvent(frame.type) &&
    !entries.some((entry) => entry.id === frame.id)
  ) {
    const entry: ChatEntry = {
      id: frame.id,
      payload: frame.payload,
      payloadRef: null,
      runId: frame.runId,
      type: frame.type,
    };
    const finishing =
      frame.type === "message.assistant" && frame.runId !== null
        ? next.deltas[frame.runId]
        : undefined;
    next = {
      ...next,
      deltas:
        frame.type === "message.assistant"
          ? withoutDelta(next.deltas, frame.runId)
          : next.deltas,
      finishedKeys:
        finishing === undefined
          ? next.finishedKeys
          : [...next.finishedKeys, finishing.messageKey],
      transcript: { ...next.transcript, entries: [...entries, entry] },
    };
  }
  const status = RUN_STATUS_OF[frame.type];
  return status !== undefined && frame.runId !== null
    ? withRunStatus(next, frame.runId, status)
    : next;
};

const applyDelta = (state: StreamState, frame: DeltaFrame): StreamState => {
  const { latestRun } = state.transcript;
  // A delta that comes after its run ended is a late copy of a stored message.
  if (latestRun?.id === frame.runId && !isRunActive(latestRun.status)) {
    return state;
  }
  // So is a delta for a message whose stored event is already in.
  if (
    state.finishedKeys.includes(frame.messageKey) ||
    isStored(state.transcript.entries, frame.runId, frame.text)
  ) {
    return state;
  }
  return {
    ...state,
    deltas: {
      ...state.deltas,
      [frame.runId]: { messageKey: frame.messageKey, text: frame.text },
    },
  };
};

export const applyFrame = (
  state: StreamState,
  frame: StreamFrame
): StreamState => {
  switch (frame.frame) {
    case "event":
      return applyEvent(state, frame);
    case "delta":
      return applyDelta(state, frame);
    case "run":
      return withRunStatus(state, frame.runId, frame.status);
    case "request": {
      const unknown = !state.requests.some(({ id }) => id === frame.requestId);
      const known =
        frame.status === "pending" && unknown && !state.needsRequests
          ? { ...state, needsRequests: true }
          : state;
      // The run frame that follows says the same; this shows it a moment sooner.
      const { latestRun } = known.transcript;
      return frame.status === "pending" && latestRun?.status === "running"
        ? withRunStatus(known, frame.runId, "waiting")
        : known;
    }
    default:
      return state;
  }
};

/** Puts each request after the last item that came before it. Items and anchors are event ids, which sort by time. */
const withRequests = (
  items: ChatItem[],
  requests: readonly RequestView[]
): ChatItem[] => {
  const out = [...items];
  for (const view of requests) {
    const anchor = view.anchorId;
    const after =
      anchor === null
        ? out.length
        : out.findLastIndex(
            (item) => item.kind === "request" || item.id <= anchor
          ) + 1;
    out.splice(after, 0, { id: `request-${view.id}`, kind: "request", view });
  }
  return out;
};

/** The chat items of the state: the transcript's with the requests among them, then each run's partial message. */
export const streamItems = (state: StreamState): ChatItem[] => {
  const { entries, outputFileIds } = state.transcript;
  const partial = Object.entries(state.deltas).map(
    ([runId, delta]): ChatItem => ({
      fileIds: [],
      id: `${runId}-${delta.messageKey}`,
      kind: "assistant",
      text: stripAttachmentMarkers(delta.text),
    })
  );
  return [
    ...withRequests(toChatItems(entries, outputFileIds), state.requests),
    ...partial,
  ];
};

/**
 * The pending requests of a fetch. Ones the chat does not know are added;
 * known ones keep their state, since an event may have settled them since.
 */
export const applyPending = (
  state: StreamState,
  records: Parameters<typeof viewFromRecord>[0][]
): StreamState => {
  const added = records.flatMap((record) => {
    if (state.requests.some(({ id }) => id === record.id)) {
      return [];
    }
    const view = viewFromRecord(
      record,
      anchorOf(state.transcript.entries, record.runId)
    );
    return view === null ? [] : [view];
  });
  return {
    ...state,
    needsRequests: false,
    requests: [...state.requests, ...added],
  };
};

/** A request settled by this browser's own answer. */
export const applySettled = (
  state: StreamState,
  requestId: string,
  settled: Settled
): StreamState => settleRequest(state, requestId, settled);
