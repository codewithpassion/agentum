/**
 * Session event handling, kept free of the SDK so the router's pump can be
 * unit-tested against plain objects.
 *
 * The events list has no "after this id" filter - only `created_at[gte]`,
 * compared against `processed_at`. So the cursor is a pair: the timestamp
 * narrows the request, and the id resolves the overlap the inclusive
 * comparison leaves behind.
 */

export type SessionStatus =
  | "idle"
  | "running"
  | "rescheduling"
  | "terminated"
  | "unknown";

/** What the router needs from an event; the raw SDK shape stays inside the gateway. */
export interface SessionEvent {
  id: string;
  /** ISO 8601, null while the event is still queued. */
  processedAt: string | null;
  /** Agent text output, when the event carries any. */
  text?: string;
  type: string;
}

export interface EventCursor {
  lastEventId: string;
  lastProcessedAt: string | null;
}

/**
 * Drops everything up to and including the cursor's event. When the cursor's
 * event is not in the page (it aged out of the `created_at[gte]` window, or the
 * cursor is empty) the whole page is new.
 */
export const eventsAfter = (
  events: readonly SessionEvent[],
  cursor: EventCursor | undefined
): SessionEvent[] => {
  if (!cursor) {
    return [...events];
  }
  const index = events.findIndex((event) => event.id === cursor.lastEventId);
  return index === -1 ? [...events] : events.slice(index + 1);
};

/** The cursor to poll with next time; unchanged when the page was empty. */
export const advanceCursor = (
  events: readonly SessionEvent[],
  cursor: EventCursor | undefined
): EventCursor | undefined => {
  const last = events.at(-1);
  if (!last) {
    return cursor;
  }
  return { lastEventId: last.id, lastProcessedAt: last.processedAt };
};

export interface PumpOutcome {
  /** Text the agent produced. We do not post it - the agent posts via MCP. */
  agentText: string[];
  error: string | null;
  status: SessionStatus;
}

const STATUS_EVENTS: Record<string, SessionStatus> = {
  "session.status_idle": "idle",
  "session.status_rescheduled": "rescheduling",
  "session.status_running": "running",
  "session.status_terminated": "terminated",
};

/**
 * Folds a page of events into what the router acts on: the last status the
 * session reported, any error, and the agent's text (kept for the UI, never
 * mirrored into the channel - the agent posts its own messages).
 */
export const reduceEvents = (
  events: readonly SessionEvent[],
  previous: SessionStatus
): PumpOutcome => {
  let status = previous;
  let error: string | null = null;
  const agentText: string[] = [];

  for (const event of events) {
    const next = STATUS_EVENTS[event.type];
    if (next) {
      status = next;
    }
    if (event.type === "session.error") {
      error = event.text ?? "The session reported an error.";
    }
    if (event.type === "agent.message" && event.text) {
      agentText.push(event.text);
    }
  }

  return { agentText, error, status };
};

/** A session we can still send into: not finished, not wedged. */
export const isSessionReusable = (status: SessionStatus): boolean =>
  status === "idle" || status === "running";
