import { describe, expect, test } from "bun:test";
import type { StreamFrame } from "@repo/protocol/stream";
import type { SessionTranscript } from "#/integrations/trpc/types";
import type { ChatEntry } from "./chat-logic";
import { statusLine, toChatItems } from "./chat-logic";
import {
  applyFrame,
  applyPending,
  applySettled,
  applyTranscript,
  type ChatTranscript,
  initialState,
  parseFrame,
  streamItems,
} from "./stream-logic";

type Entry = SessionTranscript["entries"][number];
type Run = NonNullable<SessionTranscript["latestRun"]>;

const NOW = "2026-10-16T12:00:00.000Z";

const makeRun = (overrides: Partial<Run>): Run =>
  ({
    agentId: "agent-1",
    createdAt: NOW,
    error: null,
    finishedAt: null,
    id: "run-1",
    inputText: "hello",
    outputFileIds: [],
    processEndedAt: null,
    resultText: null,
    sessionId: "session-1",
    status: "running",
    ...overrides,
  }) as Run;

const makeEntry = (overrides: Partial<Entry>): Entry =>
  ({
    actor: { id: "actor-1", kind: "user" },
    agentId: "agent-1",
    createdAt: NOW,
    id: "entry-1",
    payload: {},
    payloadRef: null,
    runId: "run-1",
    seq: 0,
    sessionId: "session-1",
    type: "message.user",
    workspaceId: "workspace-1",
    ...overrides,
  }) as Entry;

const makeTranscript = (overrides: {
  entries?: ChatEntry[];
  latestRun?: Run | null;
}): ChatTranscript =>
  ({
    entries: overrides.entries ?? [],
    latestRun: overrides.latestRun ?? null,
    outputFileIds: {},
    queue: null,
    session: { id: "session-1" },
  }) as ChatTranscript;

/** An event frame for a stored event, with its payload in the frame. */
const makeEvent = (
  overrides: Partial<Extract<StreamFrame, { frame: "event" }>>
): StreamFrame =>
  ({
    actor: { id: "actor-1", kind: "user" },
    createdAt: NOW,
    frame: "event",
    id: "ev-1",
    payload: {},
    runId: "run-1",
    seq: 0,
    type: "message.user",
    ...overrides,
  }) as StreamFrame;

/** A truncated event frame: its payload went to R2, so the frame has none. */
const makeTruncated = (id: string): StreamFrame => ({
  actor: { id: "actor-1", kind: "user" },
  createdAt: NOW,
  frame: "event",
  id,
  runId: "run-1",
  seq: 0,
  truncated: true,
  type: "message.user",
});

const makeDelta = (text: string, runId = "run-1"): StreamFrame => ({
  frame: "delta",
  messageKey: "msg-1",
  runId,
  text,
});

const makeRunFrame = (
  status: "running" | "waiting" | "done",
  runId = "run-1"
): StreamFrame => ({ frame: "run", runId, status });

describe("applyFrame events", () => {
  test("adds chat events in order and shows them as the matching items", () => {
    const frames: StreamFrame[] = [
      makeEvent({
        id: "ev-1",
        payload: { fileIds: [], text: "hi" },
        type: "message.user",
      }),
      makeEvent({
        id: "ev-2",
        payload: { input: "ls", name: "shell", toolUseId: "t1" },
        type: "tool.call",
      }),
      makeEvent({
        id: "ev-3",
        payload: { text: "done" },
        type: "message.assistant",
      }),
    ];
    const state = frames.reduce(
      applyFrame,
      initialState(makeTranscript({ latestRun: makeRun({}) }))
    );
    const {
      transcript: { entries },
    } = state;
    expect(entries.map((entry) => entry.id)).toEqual(["ev-1", "ev-2", "ev-3"]);
    expect(streamItems(state)).toEqual(toChatItems(entries));
    expect(streamItems(state)).toEqual([
      { fileIds: [], id: "ev-1", kind: "user", text: "hi" },
      {
        detail: JSON.stringify(
          { input: "ls", name: "shell", toolUseId: "t1" },
          null,
          2
        ),
        id: "ev-2",
        input: JSON.stringify("ls", null, 2),
        kind: "tool",
        label: "shell",
        output: null,
      },
      { fileIds: [], id: "ev-3", kind: "assistant", text: "done" },
    ]);
  });

  test("ignores an event whose id is already streamed", () => {
    const event = makeEvent({
      id: "ev-1",
      payload: { text: "hi" },
      type: "message.user",
    });
    const once = applyFrame(
      initialState(makeTranscript({ latestRun: makeRun({}) })),
      event
    );
    const twice = applyFrame(once, event);
    expect(twice).toEqual(once);
    expect(streamItems(twice)).toHaveLength(1);
  });

  test("ignores an event whose id is already in the initial transcript", () => {
    const stored = makeEntry({
      id: "ev-1",
      payload: { text: "hi" },
      type: "message.user",
    });
    const initial = initialState(
      makeTranscript({ entries: [stored], latestRun: makeRun({}) })
    );
    const state = applyFrame(
      initial,
      makeEvent({ id: "ev-1", payload: { text: "hi" }, type: "message.user" })
    );
    expect(state).toEqual(initial);
    expect(streamItems(state)).toHaveLength(1);
  });

  test("a truncated event adds no entry and asks for a refetch", () => {
    const initial = initialState(makeTranscript({ latestRun: makeRun({}) }));
    const state = applyFrame(initial, makeTruncated("ev-1"));
    expect(state.transcript.entries).toEqual([]);
    expect(state.needsRefetch).toBe(true);
  });

  test("a second truncated event leaves the state equal", () => {
    const frame = makeTruncated("ev-1");
    const once = applyFrame(
      initialState(makeTranscript({ latestRun: makeRun({}) })),
      frame
    );
    expect(applyFrame(once, frame)).toEqual(once);
  });

  test("a fresh transcript clears needsRefetch", () => {
    const stale = applyFrame(
      initialState(makeTranscript({ latestRun: makeRun({}) })),
      makeTruncated("ev-1")
    );
    expect(stale.needsRefetch).toBe(true);
    expect(
      applyTranscript(stale, makeTranscript({ latestRun: makeRun({}) }))
        .needsRefetch
    ).toBe(false);
  });
});

describe("applyFrame deltas", () => {
  test("shows a delta as an assistant item", () => {
    const state = applyFrame(
      initialState(makeTranscript({ latestRun: makeRun({}) })),
      makeDelta("Hel")
    );
    expect(streamItems(state)).toEqual([
      { fileIds: [], id: "run-1-msg-1", kind: "assistant", text: "Hel" },
    ]);
  });

  test("replaces the delta with a longer one, keeping one item", () => {
    const initial = initialState(makeTranscript({ latestRun: makeRun({}) }));
    const state = applyFrame(
      applyFrame(initial, makeDelta("Hel")),
      makeDelta("Hello")
    );
    expect(streamItems(state)).toEqual([
      { fileIds: [], id: "run-1-msg-1", kind: "assistant", text: "Hello" },
    ]);
  });

  test("removes the delta when the stored assistant message arrives", () => {
    const initial = initialState(makeTranscript({ latestRun: makeRun({}) }));
    const streamed = applyFrame(initial, makeDelta("Hello"));
    const state = applyFrame(
      streamed,
      makeEvent({
        id: "ev-9",
        payload: { text: "Hello there" },
        type: "message.assistant",
      })
    );
    expect(state.deltas).toEqual({});
    expect(streamItems(state)).toEqual([
      { fileIds: [], id: "ev-9", kind: "assistant", text: "Hello there" },
    ]);
  });

  test("ignores a delta for a run whose latest run is done", () => {
    const initial = initialState(
      makeTranscript({ latestRun: makeRun({ status: "done" }) })
    );
    const state = applyFrame(initial, makeDelta("late"));
    expect(state).toEqual(initial);
    expect(streamItems(state)).toEqual([]);
  });
});

describe("late deltas", () => {
  const stored = makeEvent({
    id: "ev-9",
    payload: { text: "Hello there" },
    type: "message.assistant",
  });

  test("drops a delta that follows the stored message it was a copy of", () => {
    const initial = initialState(makeTranscript({ latestRun: makeRun({}) }));
    const state = [makeDelta("Hello"), stored, makeDelta("Hello there")].reduce(
      applyFrame,
      initial
    );
    expect(state.deltas).toEqual({});
    expect(streamItems(state)).toEqual([
      { fileIds: [], id: "ev-9", kind: "assistant", text: "Hello there" },
    ]);
  });

  test("drops it even when no delta was seen before the stored message", () => {
    const initial = initialState(makeTranscript({ latestRun: makeRun({}) }));
    const state = [stored, makeDelta("Hello")].reduce(applyFrame, initial);
    expect(state.deltas).toEqual({});
  });

  test("keeps a delta of the next message of the run", () => {
    const initial = initialState(makeTranscript({ latestRun: makeRun({}) }));
    const next: StreamFrame = {
      frame: "delta",
      messageKey: "msg-2",
      runId: "run-1",
      text: "Next up",
    };
    const state = [makeDelta("Hello"), stored, next].reduce(
      applyFrame,
      initial
    );
    expect(Object.keys(state.deltas)).toEqual(["run-1"]);
    expect(streamItems(state).at(-1)?.kind).toBe("assistant");
  });

  test("a fetched transcript that holds the message clears its delta", () => {
    const streamed = applyFrame(
      initialState(makeTranscript({ latestRun: makeRun({}) })),
      makeDelta("Hello")
    );
    const state = applyTranscript(
      streamed,
      makeTranscript({
        entries: [
          {
            id: "ev-9",
            payload: { text: "Hello there" },
            payloadRef: null,
            runId: "run-1",
            type: "message.assistant",
          },
        ],
        latestRun: makeRun({}),
      })
    );
    expect(state.deltas).toEqual({});
    expect(applyFrame(state, makeDelta("Hello")).deltas).toEqual({});
  });
});

describe("requests", () => {
  const display = {
    input: { command: "ls" },
    summary: "Run `ls`",
    toolKey: "bash",
    toolName: "Bash",
  };
  const opened = makeEvent({
    id: "ev-5",
    payload: {
      display,
      expiresAt: "2026-10-16T13:00:00.000Z",
      kind: "approval",
      requestId: "req-1",
      toolKey: "bash",
      toolName: "Bash",
      toolUseId: "t1",
    },
    type: "request.opened",
  });
  const entries: ChatEntry[] = [
    {
      id: "ev-1",
      payload: { fileIds: [], text: "hi" },
      payloadRef: null,
      runId: "run-1",
      type: "message.user",
    },
    {
      id: "ev-4",
      payload: { input: "ls", name: "Bash", toolUseId: "t1" },
      payloadRef: null,
      runId: "run-1",
      type: "tool.call",
    },
  ];
  const start = () =>
    initialState(makeTranscript({ entries, latestRun: makeRun({}) }));

  test("request.opened shows a card after the run's last entry", () => {
    const state = applyFrame(start(), opened);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]?.anchorId).toBe("ev-4");
    expect(streamItems(state).map((item) => item.kind)).toEqual([
      "user",
      "tool",
      "request",
    ]);
  });

  test("a replayed opened event does not add a second card", () => {
    const state = [opened, opened].reduce(applyFrame, start());
    expect(state.requests).toHaveLength(1);
  });

  test("request.answered turns the card into a settled line", () => {
    const state = [
      opened,
      makeEvent({
        id: "ev-6",
        payload: {
          answeredBy: "user-1",
          decision: "allow_once",
          requestId: "req-1",
          via: "slack",
        },
        type: "request.answered",
      }),
    ].reduce(applyFrame, start());
    expect(state.requests[0]?.settled).toEqual({
      answer: { decision: "allow_once" },
      answeredBy: "user-1",
      status: "answered",
      via: "slack",
    });
  });

  test("the first outcome stays, but a conflict gives way to the real one", () => {
    const expired = makeEvent({
      id: "ev-7",
      payload: { requestId: "req-1" },
      type: "request.expired",
    });
    const cancelled = makeEvent({
      id: "ev-8",
      payload: { requestId: "req-1" },
      type: "request.cancelled",
    });
    const first = [opened, expired, cancelled].reduce(applyFrame, start());
    expect(first.requests[0]?.settled).toEqual({ status: "expired" });
    const conflicted = applySettled(applyFrame(start(), opened), "req-1", {
      status: "conflict",
    });
    expect(applyFrame(conflicted, expired).requests[0]?.settled).toEqual({
      status: "expired",
    });
  });

  test("a pending request frame for an unknown request asks for the pending list", () => {
    const state = applyFrame(start(), {
      frame: "request",
      kind: "approval",
      requestId: "req-9",
      runId: "run-1",
      status: "pending",
    });
    expect(state.needsRequests).toBe(true);
  });

  test("applyPending adds unknown requests and keeps settled ones settled", () => {
    const record = {
      display,
      expiresAt: "2026-10-16T13:00:00.000Z",
      id: "req-1",
      kind: "approval" as const,
      runId: "run-1",
    };
    const settled = applySettled(applyFrame(start(), opened), "req-1", {
      status: "expired",
    });
    const state = applyPending({ ...settled, needsRequests: true }, [
      record,
      { ...record, id: "req-2" },
    ]);
    expect(state.needsRequests).toBe(false);
    expect(state.requests.map((view) => view.id)).toEqual(["req-1", "req-2"]);
    expect(state.requests[0]?.settled).toEqual({ status: "expired" });
    expect(state.requests[1]?.anchorId).toBe("ev-4");
  });

  test("a card keeps its place when the run goes on", () => {
    const state = [
      opened,
      makeEvent({
        id: "ev-6",
        payload: { text: "done" },
        type: "message.assistant",
      }),
    ].reduce(applyFrame, start());
    expect(streamItems(state).map((item) => item.kind)).toEqual([
      "user",
      "tool",
      "request",
      "assistant",
    ]);
  });
});

describe("applyFrame runs", () => {
  test("updates the latest run status and the status line", () => {
    const initial = initialState(
      makeTranscript({ latestRun: makeRun({ status: "queued" }) })
    );
    const running = applyFrame(initial, makeRunFrame("running"));
    expect(running.transcript.latestRun?.status).toBe("running");
    expect(statusLine(running.transcript.latestRun ?? null, null)).toBe(
      "Running"
    );

    const waiting = applyFrame(running, makeRunFrame("waiting"));
    expect(statusLine(waiting.transcript.latestRun ?? null, null)).toBe(
      "Waiting for an answer"
    );
    expect(waiting.needsRefetch).toBe(false);
  });

  test("a terminal run frame sets needsRefetch", () => {
    const state = applyFrame(
      initialState(makeTranscript({ latestRun: makeRun({}) })),
      makeRunFrame("done")
    );
    expect(state.transcript.latestRun?.status).toBe("done");
    expect(state.needsRefetch).toBe(true);
  });

  test("a run frame for an unknown run sets needsRefetch", () => {
    const state = applyFrame(
      initialState(makeTranscript({ latestRun: makeRun({}) })),
      makeRunFrame("running", "run-2")
    );
    expect(state.transcript.latestRun?.id).toBe("run-1");
    expect(state.needsRefetch).toBe(true);
  });
});

describe("applyTranscript", () => {
  test("keeps a streamed entry newer than the fetched transcript's last entry", () => {
    const stored = makeEntry({
      id: "e1",
      payload: { text: "a" },
      type: "message.user",
    });
    const state = applyFrame(
      initialState(
        makeTranscript({ entries: [stored], latestRun: makeRun({}) })
      ),
      makeEvent({ id: "e3", payload: { text: "new" }, type: "message.user" })
    );
    const fetched = makeTranscript({
      entries: [
        stored,
        makeEntry({
          id: "e2",
          payload: { text: "b" },
          type: "message.assistant",
        }),
      ],
      latestRun: makeRun({}),
    });
    const merged = applyTranscript(state, fetched);
    expect(merged.transcript.entries.map((entry) => entry.id)).toEqual([
      "e1",
      "e2",
      "e3",
    ]);
  });

  test("drops a streamed entry that the fetched transcript already has", () => {
    const stored = makeEntry({
      id: "e1",
      payload: { text: "a" },
      type: "message.user",
    });
    const state = applyFrame(
      initialState(
        makeTranscript({ entries: [stored], latestRun: makeRun({}) })
      ),
      makeEvent({ id: "e2", payload: { text: "b" }, type: "message.assistant" })
    );
    const fetched = makeTranscript({
      entries: [
        stored,
        makeEntry({
          id: "e2",
          payload: { text: "b" },
          type: "message.assistant",
        }),
      ],
      latestRun: makeRun({}),
    });
    const merged = applyTranscript(state, fetched);
    expect(merged.transcript.entries.map((entry) => entry.id)).toEqual([
      "e1",
      "e2",
    ]);
  });
});

describe("applyFrame requests", () => {
  test("moves a running run to waiting on a pending request", () => {
    const state = applyFrame(
      initialState(
        makeTranscript({ latestRun: makeRun({ status: "running" }) })
      ),
      {
        frame: "request",
        kind: "question",
        requestId: "req-1",
        runId: "run-1",
        status: "pending",
      }
    );
    expect(state.transcript.latestRun?.status).toBe("waiting");
    expect(statusLine(state.transcript.latestRun ?? null, null)).toBe(
      "Waiting for an answer"
    );
  });
});

describe("parseFrame", () => {
  test("parses an event frame", () => {
    const frame = makeEvent({ id: "ev-1", payload: { text: "hi" } });
    expect(parseFrame(JSON.stringify(frame))).toEqual(frame);
  });

  test("parses a truncated event frame", () => {
    const frame = makeTruncated("ev-1");
    expect(parseFrame(JSON.stringify(frame))).toEqual(frame);
  });

  test("parses a delta frame", () => {
    expect(parseFrame(JSON.stringify(makeDelta("Hi")))).toEqual(
      makeDelta("Hi")
    );
  });

  test("parses a run frame", () => {
    expect(parseFrame(JSON.stringify(makeRunFrame("waiting")))).toEqual(
      makeRunFrame("waiting")
    );
  });

  test("parses a request frame", () => {
    const frame = {
      frame: "request",
      kind: "approval",
      requestId: "req-1",
      runId: "run-1",
      status: "pending",
    };
    expect(parseFrame(JSON.stringify(frame))).toEqual(frame as StreamFrame);
  });

  test("parses a ping frame", () => {
    expect(parseFrame(JSON.stringify({ frame: "ping" }))).toEqual({
      frame: "ping",
    });
  });

  test("returns null for invalid JSON", () => {
    expect(parseFrame("{not json")).toBeNull();
  });

  test("returns null for an unknown frame", () => {
    expect(parseFrame(JSON.stringify({ frame: "mystery" }))).toBeNull();
  });
});
