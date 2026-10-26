import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { getTrpc } from "#/integrations/trpc/client";
import { type ChatItem, POLL_MS, shouldPoll } from "./chat-logic.ts";
import {
  applyFrame,
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

type Action =
  | { frame: Parameters<typeof applyFrame>[1]; kind: "frame" }
  | { kind: "transcript"; transcript: ChatTranscript };

const reduce = (
  state: StreamState | null,
  action: Action
): StreamState | null => {
  if (action.kind === "transcript") {
    return applyTranscript(state, action.transcript);
  }
  return state === null ? null : applyFrame(state, action.frame);
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export interface SessionStream {
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
      if (mine === fetchCount.current) {
        dispatch({ kind: "transcript", transcript });
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
        if (failures >= MAX_FAILURES) {
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

  const items = useMemo(
    () => (state === null ? [] : streamItems(state)),
    [state]
  );

  return { error, items, reload, transcript: state?.transcript ?? null };
};
