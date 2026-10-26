import { expect, test } from "bun:test";
import type { EventFrame, StreamFrame } from "@repo/protocol/stream";
import type { ThreadEvent } from "@repo/protocol/thread";
import {
  applyThreadFrame,
  initialThread,
  resetThread,
} from "./thread-state.ts";

const at = "2026-10-26T00:00:00Z";
const event = (
  id: string,
  type: ThreadEvent["type"],
  payload: Record<string, unknown> = {},
  runId: string | null = "r1"
): ThreadEvent => ({ createdAt: at, id, payload, runId, type });
const frame = (entry: ThreadEvent): StreamFrame => ({
  ...entry,
  actor: { id: "agent", kind: "agent" },
  frame: "event",
  payload: entry.payload as Extract<
    EventFrame,
    { payload: unknown }
  >["payload"],
  seq: null,
});

test("a delta streams text and the final message.assistant event replaces it", () => {
  const streaming = applyThreadFrame(initialThread([]), {
    frame: "delta",
    messageKey: "a",
    runId: "r1",
    text: "Hi",
  });
  expect(streaming.messages[0]?.parts).toEqual([{ text: "Hi", type: "text" }]);
  expect(streaming.tail).toEqual([]);

  const done = applyThreadFrame(
    streaming,
    frame(event("1", "message.assistant", { text: "Hi there" }))
  );
  expect(done.messages).toHaveLength(1);
  expect(done.messages[0]?.parts).toEqual([{ text: "Hi there", type: "text" }]);
  expect(done.tail.map((item) => item.id)).toEqual(["1"]);
});

test("the same event frame applied twice changes nothing", () => {
  const entry = frame(event("1", "message.assistant", { text: "Hi" }));
  const once = applyThreadFrame(initialThread([]), entry);
  expect(applyThreadFrame(once, entry)).toBe(once);
});

test("resetThread with an event already applied does not duplicate the message", () => {
  const first = event("1", "message.assistant", { text: "Hello" });
  const state = applyThreadFrame(initialThread([]), frame(first));
  const reset = resetThread(state, [first]);
  expect(reset.messages).toHaveLength(1);
  expect(reset.messages[0]?.parts).toEqual([{ text: "Hello", type: "text" }]);
  expect(reset.tail).toEqual([]);
});

test("resetThread keeps a tail event newer than the fetched events", () => {
  const first = event("1", "message.assistant", { text: "Hello" });
  const newer = event("2", "run.finished");
  const state = [first, newer].reduce(
    (current, entry) => applyThreadFrame(current, frame(entry)),
    initialThread([])
  );
  const reset = resetThread(state, [first]);
  expect(reset.messages[0]?.status).toBe("done");
  expect(reset.tail.map((item) => item.id)).toEqual(["2"]);
});

test("resetThread with no events keeps the whole tail", () => {
  const state = applyThreadFrame(
    initialThread([]),
    frame(event("1", "message.assistant", { text: "Hi" }))
  );
  const reset = resetThread(state, []);
  expect(reset.messages[0]?.parts).toEqual([{ text: "Hi", type: "text" }]);
  expect(reset.tail.map((item) => item.id)).toEqual(["1"]);
});

test("a ping returns the same state object", () => {
  const state = initialThread([
    event("1", "message.assistant", { text: "Hi" }),
  ]);
  expect(applyThreadFrame(state, { frame: "ping" })).toBe(state);
});

test("initialThread of no events gives no messages and an empty tail", () => {
  expect(initialThread([])).toEqual({ messages: [], tail: [] });
});
