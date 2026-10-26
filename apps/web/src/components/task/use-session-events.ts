import type { StreamFrame } from "@repo/protocol/stream";
import { useEffect, useRef, useState } from "react";
import { parseFrame } from "#/components/agent/chat/stream-logic.ts";
import {
  FALLBACK_POLL_MS,
  shouldFallBack,
  streamUrl,
} from "./session-events-logic.ts";

export type SessionEventsMode = "poll" | "stream";

export interface SessionEventsOptions {
  /** The id of the newest stored event the caller has, or null for none. Read when a connection opens. */
  lastEventId: () => string | null;
  /** Gets every frame the stream sends. */
  onFrame: (frame: StreamFrame) => void;
  /** Fetches the caller's data again. It runs every `FALLBACK_POLL_MS` while the stream is refused. */
  refetch: () => Promise<void>;
  sessionId: string;
}

/**
 * Follows `GET /api/sessions/:sessionId/stream` from the caller's last event
 * and hands each frame to `onFrame`. The browser reconnects by itself and
 * resumes with `Last-Event-ID`. After `MAX_FAILURES` failed attempts, or when
 * the route refuses the stream, it calls `refetch` every 10 seconds instead,
 * and tries the stream again when the window regains focus. One page holds
 * one EventSource, so the task view and its thread share this hook.
 */
export const useSessionEvents = ({
  lastEventId,
  onFrame,
  refetch,
  sessionId,
}: SessionEventsOptions): { mode: SessionEventsMode } => {
  const [mode, setMode] = useState<SessionEventsMode>("stream");
  // The callbacks change on every render. The effects read the latest ones, so
  // a new callback does not close the stream.
  const latest = useRef({ lastEventId, onFrame, refetch });
  useEffect(() => {
    latest.current = { lastEventId, onFrame, refetch };
  });

  useEffect(() => {
    if (mode !== "stream") {
      return;
    }
    const source = new EventSource(
      streamUrl(sessionId, latest.current.lastEventId())
    );
    let failures = 0;
    source.onopen = () => {
      failures = 0;
    };
    source.onmessage = (message) => {
      const frame = parseFrame(String(message.data));
      if (frame !== null) {
        latest.current.onFrame(frame);
      }
    };
    source.onerror = () => {
      failures += 1;
      if (shouldFallBack(failures, source.readyState === EventSource.CLOSED)) {
        source.close();
        setMode("poll");
      }
    };
    return () => source.close();
  }, [mode, sessionId]);

  useEffect(() => {
    if (mode !== "poll") {
      return;
    }
    const timer = setInterval(() => {
      latest.current.refetch();
    }, FALLBACK_POLL_MS);
    const retryStream = () => setMode("stream");
    window.addEventListener("focus", retryStream);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", retryStream);
    };
  }, [mode]);

  return { mode };
};
