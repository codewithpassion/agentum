import { expect, test } from "bun:test";
import type { EventFrame } from "@repo/protocol/stream";
import { applyFrame, foldThread, type ThreadEvent } from "@repo/protocol/thread";

const at = "2026-10-26T00:00:00Z";
const event = (id: string, type: ThreadEvent["type"], payload: Record<string, unknown> = {}, runId: string | null = "r1"): ThreadEvent => ({ createdAt: at, id, payload, runId, type });
const frame = (entry: ThreadEvent): EventFrame => ({ ...entry, actor: { id: "agent", kind: "agent" }, frame: "event", payload: entry.payload as EventFrame extends { payload: infer P } ? P : never, seq: null });

test("two runs alternate user and assistant, with attachments and status", () => {
  const messages = foldThread([
    event("1", "message.user", { fileIds: ["f"], text: "Hi" }),
    event("2", "message.assistant", { text: "Hello" }), event("3", "run.finished"),
    event("4", "message.user", { text: "Again" }, "r2"),
    event("5", "message.assistant", { text: "Yes" }, "r2"), event("6", "run.failed", {}, "r2"),
  ]);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(messages.map((m) => m.status)).toEqual(["done", "done", "done", "failed"]);
  expect(messages[0]?.parts).toContainEqual({ type: "attachment", fileId: "f" });
  expect(messages[1]?.createdAt).toBe(at);
});

test("out of order tool results join their call", () => {
  expect(foldThread([
    event("1", "tool.result", { toolUseId: "t", output: "answer", ok: false }),
    event("2", "tool.call", { toolUseId: "t", name: "read", input: { path: "a" } }),
  ])[0]?.parts).toEqual([{ type: "tool-call", toolUseId: "t", name: "read", input: { path: "a" }, result: "answer", ok: false }]);
});

test("reasoning precedes text and assistant markers become path attachments", () => {
  expect(foldThread([
    event("1", "message.assistant", { text: "Done [ATTACHMENT:/tmp/a]" }),
    event("2", "message.reasoning", { text: "Think" }),
  ])[0]?.parts).toEqual([{ type: "reasoning", text: "Think" }, { type: "text", text: "Done" }, { type: "attachment", path: "/tmp/a" }]);
});

test("waiting requests retain opened payload and settlement details", () => {
  const opened = { requestId: "q", kind: "question", display: { questions: [{ question: "Why?" }] }, expiresAt: at, toolUseId: "t" };
  let messages = foldThread([event("1", "request.opened", opened), event("2", "run.waiting")]);
  expect(messages[0]?.status).toBe("waiting");
  expect(messages[0]?.parts).toEqual([{ ...opened, type: "request", status: "pending" }]);
  messages = applyFrame(messages, frame(event("3", "request.answered", { requestId: "q", answers: { "Why?": "Because" }, answeredBy: "u", via: "web" })));
  expect(messages[0]?.parts[0]).toMatchObject({ status: "answered", settlement: { answers: { "Why?": "Because" }, answeredBy: "u", via: "web" } });
});

test("event replay is a no-op for live and stored history", () => {
  const entry = event("1", "message.assistant", { text: "Hi" });
  const messages = foldThread([entry]);
  expect(applyFrame(messages, frame(entry))).toBe(messages);
  const live = applyFrame([], frame(entry));
  expect(applyFrame(live, frame(entry))).toBe(live);
});

test("deltas replace text, stored text ends them, and new keys may share a prefix", () => {
  let messages = applyFrame([], { frame: "delta", messageKey: "a", runId: "r1", text: "Hi" });
  const before = messages;
  messages = applyFrame(messages, { frame: "delta", messageKey: "a", runId: "r1", text: "Hi there" });
  expect(before[0]?.parts).toEqual([{ type: "text", text: "Hi" }]);
  expect(messages[0]?.parts).toEqual([{ type: "text", text: "Hi there" }]);
  messages = applyFrame(messages, frame(event("1", "message.assistant", { text: "Hi there!" })));
  expect(applyFrame(messages, { frame: "delta", messageKey: "a", runId: "r1", text: "Hi there" })).toBe(messages);
  messages = applyFrame(messages, { frame: "delta", messageKey: "b", runId: "r1", text: "Hi" });
  expect(messages[0]?.parts).toEqual([{ type: "text", text: "Hi there!" }, { type: "text", text: "Hi" }]);
});

test("truncated frames have placeholders; run and ping frames work by value", () => {
  const { payload: _payload, ...base } = frame(event("1", "message.assistant"));
  let messages = applyFrame([], { ...base, truncated: true });
  expect(messages[0]?.parts).toEqual([{ type: "placeholder", eventId: "1", eventType: "message.assistant" }]);
  messages = applyFrame(messages, { frame: "run", runId: "r1", status: "cancelled" });
  expect(messages[0]?.status).toBe("cancelled");
  expect(applyFrame(messages, { frame: "delta", runId: "r1", messageKey: "late", text: "late" })).toBe(messages);
  expect(applyFrame(messages, { frame: "ping" })).toBe(messages);
});
