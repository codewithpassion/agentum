import { describe, expect, test } from "bun:test";
import {
  advanceCursor,
  eventsAfter,
  isSessionReusable,
  reduceEvents,
  type SessionEvent,
} from "./events";

const event = (
  id: string,
  type: string,
  text?: string,
  processedAt = "2026-08-20T10:00:00Z"
): SessionEvent => ({ id, processedAt, text, type });

describe("eventsAfter", () => {
  const page = [
    event("a", "session.status_running"),
    event("b", "agent.message", "hi"),
    event("c", "session.status_idle"),
  ];

  test("returns the whole page when there is no cursor", () => {
    expect(eventsAfter(page, undefined)).toHaveLength(3);
  });

  test("drops everything up to and including the cursor's event", () => {
    const fresh = eventsAfter(page, {
      lastEventId: "a",
      lastProcessedAt: null,
    });

    expect(fresh.map((entry) => entry.id)).toEqual(["b", "c"]);
  });

  test("returns nothing when the cursor is already at the end", () => {
    expect(
      eventsAfter(page, { lastEventId: "c", lastProcessedAt: null })
    ).toEqual([]);
  });

  test("keeps the page when the cursor's event is no longer in it", () => {
    // The inclusive `created_at[gte]` window can slide past the cursor event.
    expect(
      eventsAfter(page, { lastEventId: "gone", lastProcessedAt: null })
    ).toHaveLength(3);
  });
});

describe("advanceCursor", () => {
  test("moves to the last event of the page", () => {
    const cursor = advanceCursor(
      [
        event("a", "agent.message"),
        event("b", "session.status_idle", undefined, "later"),
      ],
      undefined
    );

    expect(cursor).toEqual({ lastEventId: "b", lastProcessedAt: "later" });
  });

  test("holds position when the page is empty", () => {
    const previous = { lastEventId: "a", lastProcessedAt: "now" };

    expect(advanceCursor([], previous)).toBe(previous);
  });
});

describe("reduceEvents", () => {
  test("takes the last status the session reported", () => {
    const outcome = reduceEvents(
      [
        event("a", "session.status_running"),
        event("b", "agent.message", "working on it"),
        event("c", "session.status_idle"),
      ],
      "unknown"
    );

    expect(outcome.status).toBe("idle");
    expect(outcome.agentText).toEqual(["working on it"]);
    expect(outcome.error).toBeNull();
  });

  test("keeps the previous status when the page carries none", () => {
    expect(reduceEvents([event("a", "agent.thinking")], "running").status).toBe(
      "running"
    );
  });

  test("surfaces a session error", () => {
    const outcome = reduceEvents(
      [event("a", "session.error", "the model was overloaded")],
      "running"
    );

    expect(outcome.error).toBe("the model was overloaded");
  });

  test("reports a terminated session", () => {
    expect(
      reduceEvents([event("a", "session.status_terminated")], "running").status
    ).toBe("terminated");
  });
});

describe("isSessionReusable", () => {
  test("only an idle or running session takes another message", () => {
    expect(isSessionReusable("idle")).toBe(true);
    expect(isSessionReusable("running")).toBe(true);
    expect(isSessionReusable("terminated")).toBe(false);
    expect(isSessionReusable("unknown")).toBe(false);
  });
});
