// The chat's view of a session stream (V1.6). `applyFrame` folds the frames of
// `GET /api/sessions/:sessionId/stream` into the transcript the chat shows, so
// `toChatItems` reads the same list whether it came from a fetch or the stream.
// Pure: the hook owns the EventSource and the fetches.

import type { EventType, RunStatus } from "@repo/db/shared";
import { stripAttachmentMarkers } from "@repo/protocol/attachments";
import {
  type EventFrame,
  type StreamFrame,
  streamFrameSchema,
} from "@repo/protocol/stream";
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
  /** True when the stream cannot show something and the transcript should be fetched again. */
  needsRefetch: boolean;
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
  needsRefetch: false,
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
  const deltas =
    latestRun !== null && isRunActive(latestRun.status)
      ? Object.fromEntries(
          Object.entries(state.deltas).filter(
            ([runId]) => runId === latestRun.id
          )
        )
      : {};
  return {
    deltas,
    needsRefetch: false,
    transcript: { ...transcript, entries: [...transcript.entries, ...newer] },
  };
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

const applyEvent = (state: StreamState, frame: EventFrame): StreamState => {
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
    next = {
      ...next,
      deltas:
        frame.type === "message.assistant"
          ? withoutDelta(next.deltas, frame.runId)
          : next.deltas,
      transcript: { ...next.transcript, entries: [...entries, entry] },
    };
  }
  const status = RUN_STATUS_OF[frame.type];
  return status !== undefined && frame.runId !== null
    ? withRunStatus(next, frame.runId, status)
    : next;
};

const applyDelta = (
  state: StreamState,
  frame: Extract<StreamFrame, { frame: "delta" }>
): StreamState => {
  const { latestRun } = state.transcript;
  // A delta that comes after its run ended is a late copy of a stored message.
  if (latestRun?.id === frame.runId && !isRunActive(latestRun.status)) {
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
      // The run frame that follows would say the same; this covers a replay, which has no run frames.
      const { latestRun } = state.transcript;
      return frame.status === "pending" && latestRun?.status === "running"
        ? withRunStatus(state, frame.runId, "waiting")
        : state;
    }
    default:
      return state;
  }
};

/** The chat items of the state: the transcript's, then each run's partial message. */
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
  return [...toChatItems(entries, outputFileIds), ...partial];
};
