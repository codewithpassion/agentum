import type { StreamFrame } from "@repo/protocol/stream";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  type AnswerPayload,
  isConflict,
  type RequestView,
  type Settled,
} from "#/components/requests/request-card-logic.ts";
import { getTrpc } from "#/integrations/trpc/client";
import { type ChatItem, POLL_MS, shouldPoll } from "./chat-logic.ts";
import {
  applyFrame,
  applyPending,
  applySettled,
  applyTranscript,
  type ChatTranscript,
  lastEntryId,
  parseFrame,
  type StreamState,
  streamItems,
} from "./stream-logic.ts";

/** Failed connection attempts in a row before the chat goes back to polling. */
const MAX_FAILURES = 3;
/** Sorts before every event id, so the stream replays the whole session. */
const FROM_START = "0";

type Mode = "poll" | "stream";

type PendingRecords = Parameters<typeof applyPending>[1];

type Action =
  | { frame: StreamFrame; kind: "frame" }
  | { kind: "pending"; records: PendingRecords }
  | { kind: "settled"; requestId: string; settled: Settled }
  | { kind: "transcript"; transcript: ChatTranscript };

const reduce = (
  state: StreamState | null,
  action: Action
): StreamState | null => {
  if (action.kind === "transcript") {
    return applyTranscript(state, action.transcript);
  }
  if (state === null) {
    return null;
  }
  switch (action.kind) {
    case "pending":
      return applyPending(state, action.records);
    case "settled":
      return applySettled(state, action.requestId, action.settled);
    default:
      return applyFrame(state, action.frame);
  }
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export interface SessionStream {
  /** Sends a person's answer to a request. A request that was answered elsewhere settles instead of failing. */
  answer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  error: string | null;
  items: ChatItem[];
  /** Fetches the transcript now, for after the chat changed the session itself. */
  reload: () => Promise<void>;
  transcript: ChatTranscript | null;
}

/**
 * The transcript of a session, kept live. It loads the transcript once, then
 * follows the session stream from the last stored event. The browser
 * reconnects by itself and resumes with `Last-Event-ID`. After
 * `MAX_FAILURES` failed attempts it polls instead, and tries the stream again
 * when the page regains focus.
 */
export const useSessionStream = (
  sessionId: string | undefined
): SessionStream => {
  const [state, dispatch] = useReducer(reduce, null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("stream");
  // Numbers the fetches, so an answer that a newer fetch has passed is dropped.
  const fetchCount = useRef(0);

  const load = useCallback(async (): Promise<ChatTranscript | null> => {
    if (sessionId === undefined) {
      return null;
    }
    fetchCount.current += 1;
    const mine = fetchCount.current;
    try {
      const transcript = await getTrpc().sessions.transcript.query({
        sessionId,
      });
      const pending = await getTrpc().requests.pending.query({ sessionId });
      if (mine === fetchCount.current) {
        dispatch({ kind: "transcript", transcript });
        dispatch({ kind: "pending", records: pending });
        setError(null);
      }
      return transcript;
    } catch (cause) {
      setError(messageOf(cause));
      return null;
    }
  }, [sessionId]);

  const reload = useCallback(async () => {
    await load();
  }, [load]);

  useEffect(() => {
    if (sessionId === undefined || mode !== "stream") {
      return;
    }
    let source: EventSource | null = null;
    let stopped = false;
    load().then((transcript) => {
      if (stopped || transcript === null) {
        return;
      }
      const after = lastEntryId(transcript) ?? FROM_START;
      const opened = new EventSource(
        `/api/sessions/${encodeURIComponent(sessionId)}/stream?after=${encodeURIComponent(after)}`
      );
      source = opened;
      let failures = 0;
      opened.onopen = () => {
        failures = 0;
      };
      opened.onmessage = (message) => {
        const frame = parseFrame(String(message.data));
        if (frame !== null) {
          dispatch({ frame, kind: "frame" });
        }
      };
      opened.onerror = () => {
        failures += 1;
        // A closed source will not reconnect: the route refused it (a 401
        // after the session ended, a 404, a 500), so poll straight away.
        if (
          failures >= MAX_FAILURES ||
          opened.readyState === EventSource.CLOSED
        ) {
          opened.close();
          setMode("poll");
        }
      };
    });
    return () => {
      stopped = true;
      source?.close();
    };
  }, [load, mode, sessionId]);

  const latestRun = state?.transcript.latestRun ?? null;
  const polling = mode === "poll" && shouldPoll(latestRun, Date.now());

  useEffect(() => {
    if (!polling) {
      return;
    }
    const id = setInterval(() => {
      load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [load, polling]);

  useEffect(() => {
    if (mode !== "poll") {
      return;
    }
    const retryStream = () => setMode("stream");
    window.addEventListener("focus", retryStream);
    return () => window.removeEventListener("focus", retryStream);
  }, [mode]);

  const needsRefetch = state?.needsRefetch;
  useEffect(() => {
    if (needsRefetch) {
      load();
    }
  }, [load, needsRefetch]);

  // A request the chat has not heard of is in the pending list, not the transcript.
  const needsRequests = state?.needsRequests;
  useEffect(() => {
    if (needsRequests && sessionId !== undefined) {
      getTrpc()
        .requests.pending.query({ sessionId })
        .then((records) => dispatch({ kind: "pending", records }))
        .catch((cause: unknown) => setError(messageOf(cause)));
    }
  }, [needsRequests, sessionId]);

  const answer = useCallback(
    async (view: RequestView, payload: AnswerPayload) => {
      try {
        const record = await getTrpc().requests.answer.mutate({
          ...payload,
          requestId: view.id,
        });
        dispatch({
          kind: "settled",
          requestId: view.id,
          settled: {
            answer: record.answer ?? payload,
            answeredBy: record.answeredBy,
            status: "answered",
            via: "web",
          },
        });
      } catch (cause) {
        if (!isConflict(cause)) {
          throw cause;
        }
        dispatch({
          kind: "settled",
          requestId: view.id,
          settled: { status: "conflict" },
        });
      }
    },
    []
  );

  const items = useMemo(
    () => (state === null ? [] : streamItems(state)),
    [state]
  );

  return {
    answer,
    error,
    items,
    reload,
    transcript: state?.transcript ?? null,
  };
};
