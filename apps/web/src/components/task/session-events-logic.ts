// The rules of the session event transport (V2.11), kept pure so they can be
// tested. `use-session-events.ts` owns the EventSource and applies them.

import { type StreamFrame, streamFrameSchema } from "@repo/protocol/stream";

/** Failed connection attempts in a row before the page goes back to polling. */
export const MAX_FAILURES = 3;

/** How often the fallback fetches the task again. */
export const FALLBACK_POLL_MS = 10_000;

/** Sorts before every event id, so the stream replays the whole session. */
export const FROM_START = "0";

/** The stream route of a session, resuming after the event `after`. */
export const streamUrl = (sessionId: string, after: string | null): string =>
  `/api/sessions/${encodeURIComponent(sessionId)}/stream?after=${encodeURIComponent(after ?? FROM_START)}`;

/**
 * True when the page should stop trying the stream and poll. A closed source
 * will not reconnect: the route refused it (a 401 after the session ended, a
 * 404, a 500), so it polls straight away.
 */
export const shouldFallBack = (failures: number, closed: boolean): boolean =>
  closed || failures >= MAX_FAILURES;

/** Parses one frame of the stream. Returns null for bad JSON or an unknown frame. */
export const parseFrame = (data: string): StreamFrame | null => {
  try {
    const parsed = streamFrameSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
