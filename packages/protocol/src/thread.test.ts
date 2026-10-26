import { expect, test } from "bun:test";
import type { EventFrame } from "@repo/protocol/stream";
import {
  applyFrame,
  foldThread,
  type ThreadEvent,
} from "@repo/protocol/thread";

const at = "2026-10-26T00:00:00Z";
const event = (
  id: string,
  type: ThreadEvent["type"],
  payload: Record<string, unknown> = {},
  runId: string | null = "r1"
): ThreadEvent => ({ createdAt: at, id, payload, runId, type });
const frame = (
  entry: ThreadEvent
): Extract<EventFrame, { payload: unknown }> => ({
  ...entry,
  actor: { id: "agent", kind: "agent" },
  frame: "event",
  payload: entry.payload as Extract<
    EventFrame,
    { payload: unknown }
  >["payload"],
  seq: null,
});

test("two runs alternate user and assistant, with attachments and status", () => {
  const messages = foldThread([
    event("1", "message.user", { fileIds: ["f"], text: "Hi" }),
    event("2", "message.assistant", { text: "Hello" }),
    event("3", "run.finished"),
    event("4", "message.user", { text: "Again" }, "r2"),
    event("5", "message.assistant", { text: "Yes" }, "r2"),
    event("6", "run.failed", {}, "r2"),
  ]);
  expect(messages.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  expect(messages.map((m) => m.status)).toEqual([
    "done",
    "done",
    "done",
    "failed",
  ]);
  expect(messages[0]?.parts).toContainEqual({
    fileId: "f",
    type: "attachment",
  });
  expect(messages[1]?.createdAt).toBe(at);
});

test("out of order tool results join their call", () => {
  expect(
    foldThread([
      event("1", "tool.result", {
        ok: false,
        output: "answer",
        toolUseId: "t",
      }),
      event("2", "tool.call", {
        input: { path: "a" },
        name: "read",
        toolUseId: "t",
      }),
    ])[0]?.parts
  ).toEqual([
    {
      input: { path: "a" },
      name: "read",
      ok: false,
      result: "answer",
      toolUseId: "t",
      type: "tool-call",
    },
  ]);
});

test("reasoning precedes text and assistant markers become path attachments", () => {
  expect(
    foldThread([
      event("1", "message.assistant", { text: "Done [ATTACHMENT:/tmp/a]" }),
      event("2", "message.reasoning", { text: "Think" }),
    ])[0]?.parts
  ).toEqual([
    { text: "Think", type: "reasoning" },
    { text: "Done", type: "text" },
    { path: "/tmp/a", type: "attachment" },
  ]);
});

test("waiting requests retain opened payload and settlement details", () => {
  const opened = {
    display: { questions: [{ question: "Why?" }] },
    expiresAt: at,
    kind: "question" as const,
    requestId: "q",
    toolUseId: "t",
  };
  let messages = foldThread([
    event("1", "request.opened", opened),
    event("2", "run.waiting"),
  ]);
  expect(messages[0]?.status).toBe("waiting");
  expect(messages[0]?.parts).toEqual([
    { ...opened, status: "pending", type: "request" },
  ]);
  messages = applyFrame(
    messages,
    frame(
      event("3", "request.answered", {
        answeredBy: "u",
        answers: { "Why?": "Because" },
        requestId: "q",
        via: "web",
      })
    )
  );
  expect(messages[0]?.parts[0]).toMatchObject({
    settlement: { answeredBy: "u", answers: { "Why?": "Because" }, via: "web" },
    status: "answered",
  });
});

test("event replay is a no-op for live and stored history", () => {
  const entry = event("1", "message.assistant", { text: "Hi" });
  const messages = foldThread([entry]);
  expect(applyFrame(messages, frame(entry))).toBe(messages);
  const live = applyFrame([], frame(entry));
  expect(applyFrame(live, frame(entry))).toBe(live);
});

test("deltas replace text, stored text ends them, and new keys may share a prefix", () => {
  let messages = applyFrame([], {
    frame: "delta",
    messageKey: "a",
    runId: "r1",
    text: "Hi",
  });
  const before = messages;
  messages = applyFrame(messages, {
    frame: "delta",
    messageKey: "a",
    runId: "r1",
    text: "Hi there",
  });
  expect(before[0]?.parts).toEqual([{ text: "Hi", type: "text" }]);
  expect(messages[0]?.parts).toEqual([{ text: "Hi there", type: "text" }]);
  messages = applyFrame(
    messages,
    frame(event("1", "message.assistant", { text: "Hi there!" }))
  );
  expect(
    applyFrame(messages, {
      frame: "delta",
      messageKey: "a",
      runId: "r1",
      text: "Hi there",
    })
  ).toBe(messages);
  messages = applyFrame(messages, {
    frame: "delta",
    messageKey: "b",
    runId: "r1",
    text: "Hi",
  });
  expect(messages[0]?.parts).toEqual([
    { text: "Hi there!", type: "text" },
    { text: "Hi", type: "text" },
  ]);
});

test("truncated frames have placeholders; run and ping frames work by value", () => {
  const { payload: _payload, ...base } = frame(event("1", "message.assistant"));
  let messages = applyFrame([], { ...base, truncated: true });
  expect(messages[0]?.parts).toEqual([
    { eventId: "1", eventType: "message.assistant", type: "placeholder" },
  ]);
  messages = applyFrame(messages, {
    frame: "run",
    runId: "r1",
    status: "cancelled",
  });
  expect(messages[0]?.status).toBe("cancelled");
  expect(
    applyFrame(messages, {
      frame: "delta",
      messageKey: "late",
      runId: "r1",
      text: "late",
    })
  ).toBe(messages);
  expect(applyFrame(messages, { frame: "ping" })).toBe(messages);
});

test("queued events before user input preserve message order", () => {
  expect(
    foldThread([
      event("1", "run.queued"),
      event("2", "message.user", { text: "Hello" }),
      event("3", "run.started"),
      event("4", "message.assistant", { text: "Hi" }),
    ]).map((message) => message.role)
  ).toEqual(["user", "assistant"]);
});

test("tools with the same id in different runs stay separate", () => {
  const messages = foldThread([
    event("1", "tool.call", { input: {}, name: "read", toolUseId: "t" }),
    event(
      "2",
      "tool.result",
      { ok: true, output: "second", toolUseId: "t" },
      "r2"
    ),
    event("3", "tool.result", { ok: false, output: "first", toolUseId: "t" }),
  ]);
  expect(messages[0]?.parts[0]).toMatchObject({ ok: false, result: "first" });
  expect(messages[1]?.parts[0]).toMatchObject({ ok: true, result: "second" });
});

test("approval cards accept status-only frames and retain full settlement events", () => {
  let messages = foldThread([
    event("1", "request.opened", {
      display: { input: {}, summary: "Run", toolKey: "bash", toolName: "bash" },
      expiresAt: at,
      kind: "approval",
      requestId: "a",
      toolUseId: "t",
    }),
  ]);
  messages = applyFrame(messages, {
    frame: "request",
    kind: "approval",
    requestId: "a",
    runId: "r1",
    status: "pending",
  });
  expect(messages[0]?.status).toBe("waiting");
  messages = applyFrame(messages, {
    frame: "request",
    kind: "approval",
    requestId: "a",
    runId: "r1",
    status: "answered",
  });
  messages = applyFrame(
    messages,
    frame(
      event("2", "request.answered", {
        answeredBy: "u",
        decision: "deny",
        note: "No",
        requestId: "a",
        via: "slack",
      })
    )
  );
  expect(messages[0]?.parts[0]).toMatchObject({
    settlement: { answeredBy: "u", decision: "deny", note: "No", via: "slack" },
    status: "answered",
  });
});

test("stored blob payloads and runless truncated events remain visible", () => {
  expect(
    foldThread([{ ...event("1", "tool.result"), payloadRef: "blob" }])[0]?.parts
  ).toEqual([{ eventId: "1", eventType: "tool.result", type: "placeholder" }]);
  const { payload: _payload, ...base } = frame(
    event("2", "message.assistant", {}, null)
  );
  expect(applyFrame([], { ...base, truncated: true })[0]?.parts).toEqual([
    { eventId: "2", eventType: "message.assistant", type: "placeholder" },
  ]);
});

test("reasoning inserted during a delta preserves its replacement position", () => {
  let messages = applyFrame([], {
    frame: "delta",
    messageKey: "a",
    runId: "r1",
    text: "Partial",
  });
  messages = applyFrame(
    messages,
    frame(event("1", "message.reasoning", { text: "Thinking" }))
  );
  messages = applyFrame(messages, {
    frame: "delta",
    messageKey: "a",
    runId: "r1",
    text: "Final",
  });
  expect(messages[0]?.parts).toEqual([
    { text: "Thinking", type: "reasoning" },
    { text: "Final", type: "text" },
  ]);
});
