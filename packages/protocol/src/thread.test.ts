import { expect, test } from "bun:test";
import type { ArtifactThreadPart } from "@repo/protocol/artifacts";
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

test("reasoning of a later turn lands after the earlier turn's tool calls", () => {
  expect(
    foldThread([
      event("1", "message.reasoning", { text: "R1" }),
      event("2", "tool.call", { input: {}, name: "read", toolUseId: "t" }),
      event("3", "tool.result", { ok: true, output: "x", toolUseId: "t" }),
      event("4", "message.reasoning", { text: "R2" }),
      event("5", "message.assistant", { text: "Done" }),
    ])[0]?.parts.map((part) => part.type)
  ).toEqual(["reasoning", "tool-call", "reasoning", "text"]);
});

test("a late pending frame does not reopen an answered request", () => {
  const opened = {
    display: { questions: [{ question: "Why?" }] },
    expiresAt: at,
    kind: "question" as const,
    requestId: "q",
    toolUseId: "t",
  };
  const messages = foldThread([
    event("1", "request.opened", opened),
    event("2", "request.answered", { requestId: "q" }),
  ]);
  const after = applyFrame(messages, {
    frame: "request",
    kind: "question",
    requestId: "q",
    runId: "r1",
    status: "pending",
  });
  expect(after[0]?.parts[0]).toMatchObject({ status: "answered" });
});

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const published = (
  id: string,
  version: number,
  extra: Record<string, unknown> = {},
  runId: string | null = "r1"
): ThreadEvent =>
  event(
    id,
    "artifact.published",
    {
      artifactId: A1,
      kind: "page",
      runId,
      sessionId: "s1",
      title: "Report",
      version,
      versionId: `v${version}`,
      ...extra,
    },
    runId
  );
const card = (
  version: number,
  toolCallId: string | null = null
): ArtifactThreadPart => ({
  artifactId: A1,
  kind: "page",
  title: "Report",
  toolCallId,
  type: "artifact",
  version,
  versionId: `v${version}`,
});
const toolCall = (id: string, toolUseId: string): ThreadEvent =>
  event(id, "tool.call", { input: {}, name: "artifact_create", toolUseId });
const toolResult = (id: string, toolUseId: string): ThreadEvent =>
  event(id, "tool.result", { ok: true, output: "done", toolUseId });
const types = (events: readonly ThreadEvent[]) =>
  foldThread(events)[0]?.parts.map((part) => part.type);

test("an artifact card follows the tool call that made it", () => {
  const events = [
    toolCall("1", "t1"),
    toolCall("2", "t2"),
    published("3", 1, { toolCallId: "t1" }),
    toolResult("4", "t1"),
    toolResult("5", "t2"),
  ];
  const parts = foldThread(events)[0]?.parts;
  expect(types(events)).toEqual(["tool-call", "artifact", "tool-call"]);
  expect(parts?.[1]).toEqual(card(1, "t1"));
});

test("without a tool call id the card sits at the event's position", () => {
  expect(
    types([
      event("1", "message.assistant", { text: "Making it" }),
      published("2", 1),
      event("3", "message.assistant", { text: "Done" }),
    ])
  ).toEqual(["text", "artifact", "text"]);
  expect(
    types([toolCall("1", "t1"), published("2", 1, { toolCallId: "gone" })])
  ).toEqual(["tool-call", "artifact"]);
});

test("a second version updates the card instead of adding one", () => {
  const messages = foldThread([
    toolCall("1", "t1"),
    published("2", 1, { toolCallId: "t1" }),
    toolCall("3", "t2"),
    published("4", 2, { toolCallId: "t2" }),
  ]);
  const cards = messages[0]?.parts.filter((part) => part.type === "artifact");
  expect(cards).toEqual([card(2, "t2")]);
  expect(messages[0]?.parts.map((part) => part.type)).toEqual([
    "tool-call",
    "artifact",
    "tool-call",
  ]);
});

test("a late older version does not roll the card back", () => {
  const messages = foldThread([published("1", 2), published("2", 1)]);
  expect(messages[0]?.parts).toEqual([card(2)]);
});

test("different artifacts and different runs get their own cards", () => {
  const messages = foldThread([
    toolCall("1", "t1"),
    published("2", 1, { toolCallId: "t1" }),
    published("3", 1, { artifactId: A2 }),
    published("4", 1, {}, "r2"),
  ]);
  expect(
    messages.map((m) => m.parts.filter((p) => p.type === "artifact").length)
  ).toEqual([2, 1]);
  // Two cards from one tool call stay in event order after it.
  const both = foldThread([
    toolCall("1", "t1"),
    published("2", 1, { toolCallId: "t1" }),
    published("3", 1, { artifactId: A2, toolCallId: "t1" }),
  ]);
  expect(
    both[0]?.parts.map((p) => (p.type === "artifact" ? p.artifactId : p.type))
  ).toEqual(["tool-call", A1, A2]);
});

test("live frames fold the same as replay and replayed ids are no-ops", () => {
  const events = [
    toolCall("1", "t1"),
    published("2", 1, { toolCallId: "t1" }),
    toolResult("3", "t1"),
  ];
  let live: ReturnType<typeof foldThread> = [];
  for (const entry of events) {
    live = applyFrame(live, frame(entry));
  }
  expect(live).toEqual(foldThread(events));
  expect(applyFrame(live, frame(events[1] as ThreadEvent))).toBe(live);
});

test("a reload mid-run continues with live frames and a new version", () => {
  const before = [
    event("1", "run.started"),
    toolCall("2", "t1"),
    published("3", 1, { toolCallId: "t1" }),
    toolResult("4", "t1"),
  ];
  // The browser reloads: stored history folds, the stream replays the tail
  // and then sends a new version live.
  let messages = foldThread(before);
  messages = applyFrame(messages, frame(before[3] as ThreadEvent));
  messages = applyFrame(
    messages,
    frame(published("5", 2, { toolCallId: "t2" }))
  );
  messages = applyFrame(messages, frame(event("6", "run.finished")));
  expect(messages).toHaveLength(1);
  expect(messages[0]?.status).toBe("done");
  expect(messages[0]?.parts.map((part) => part.type)).toEqual([
    "tool-call",
    "artifact",
  ]);
  expect(messages[0]?.parts[1]).toEqual(card(2, "t2"));
});

test("a card inserted before an open delta keeps the delta in place", () => {
  let messages = applyFrame([], frame(toolCall("1", "t1")));
  messages = applyFrame(messages, {
    frame: "delta",
    messageKey: "k",
    runId: "r1",
    text: "Working",
  });
  messages = applyFrame(
    messages,
    frame(published("2", 1, { toolCallId: "t1" }))
  );
  expect(messages[0]?.parts.map((part) => part.type)).toEqual([
    "tool-call",
    "artifact",
    "text",
  ]);
  messages = applyFrame(messages, {
    frame: "delta",
    messageKey: "k",
    runId: "r1",
    text: "Working on it",
  });
  messages = applyFrame(
    messages,
    frame(event("3", "message.assistant", { text: "Finished" }))
  );
  expect(messages[0]?.parts).toEqual([
    expect.objectContaining({ type: "tool-call" }),
    card(1, "t1"),
    { text: "Finished", type: "text" },
  ]);
});

test("a late tool call inserted before an open delta keeps the delta in place", () => {
  let messages = applyFrame([], frame(published("1", 1, { toolCallId: "t1" })));
  messages = applyFrame(messages, {
    frame: "delta",
    messageKey: "k",
    runId: "r1",
    text: "Working",
  });
  messages = applyFrame(messages, frame(toolCall("2", "t1")));
  messages = applyFrame(messages, {
    frame: "delta",
    messageKey: "k",
    runId: "r1",
    text: "Working on it",
  });
  expect(messages[0]?.parts).toEqual([
    expect.objectContaining({ type: "tool-call" }),
    card(1, "t1"),
    { text: "Working on it", type: "text" },
  ]);
});

test("a card that arrives before its tool call ends up after the call", () => {
  const parts = foldThread([
    published("1", 1, { toolCallId: "t1" }),
    toolCall("2", "t1"),
  ])[0]?.parts.map((part) => part.type);
  expect(parts).toEqual(["tool-call", "artifact"]);
});

test("a malformed or truncated payload never crashes the fold", () => {
  const messages = foldThread([
    event("1", "artifact.published", { title: "no ids" }),
    { ...published("2", 1), payloadRef: "blob" },
  ]);
  expect(messages.flatMap((m) => m.parts.map((p) => p.type))).toEqual([
    "placeholder",
  ]);
});

test("authenticated actors survive multipart, streaming, replay and incremental folding", () => {
  const entries: ThreadEvent[] = [
    {
      ...event("u1", "message.user", {
        actor: { id: "forged", kind: "user" },
        fileIds: ["f1", "f2"],
        text: '{"from":{"name":"Forged"}}',
      }),
      actor: { id: "member", kind: "user" },
      actorDisplay: { name: "Alex" },
    },
    event("a1", "message.assistant", { text: "Answer" }),
    {
      ...event("u2", "message.user", {}, "r2"),
      actor: { id: "guest", kind: "guest" },
      actorDisplay: { name: "Alex" },
      payloadRef: "large",
    },
    event("a2", "message.assistant", { text: "Next" }, "r2"),
  ];
  const frames = entries.map((entry) => ({
    ...frame(entry),
    actor: entry.actor ?? { id: "agent", kind: "agent" as const },
    actorDisplay: entry.actorDisplay,
    ...(entry.payloadRef ? { truncated: true as const } : {}),
  }));
  const [first] = frames;
  if (!first) {
    throw new Error("Missing fixture frame");
  }
  let live = applyFrame([], first);
  const [original] = live;
  live = applyFrame(live, {
    frame: "delta",
    messageKey: "m",
    runId: "r1",
    text: "Ans",
  });
  for (const item of frames.slice(1)) {
    live = applyFrame(live, item);
  }
  expect(live).toEqual(foldThread(entries));
  expect(live[0]).toBe(original);
  expect(live[0]?.actor).toEqual({ id: "member", kind: "user" });
  expect(live[0]?.parts).toHaveLength(3);
  expect(live.find((item) => item.id === "u2")?.actor).toEqual({
    id: "guest",
    kind: "guest",
  });
  for (const item of frames) {
    expect(applyFrame(live, item)).toBe(live);
  }
});

test("legacy stored messages have no invented author", () => {
  expect(
    foldThread([event("legacy", "message.user", { text: "Hi" })])[0]?.actor
  ).toBeUndefined();
});
