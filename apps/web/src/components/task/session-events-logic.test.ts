import { expect, test } from "bun:test";
import type { StreamFrame } from "@repo/protocol/stream";
import {
  FROM_START,
  MAX_FAILURES,
  parseFrame,
  shouldFallBack,
  streamUrl,
} from "./session-events-logic.ts";

const NOW = "2026-10-16T12:00:00.000Z";

const eventFrame: StreamFrame = {
  actor: { id: "actor-1", kind: "user" },
  createdAt: NOW,
  frame: "event",
  id: "ev-1",
  payload: { text: "hi" },
  runId: "run-1",
  seq: 0,
  type: "message.user",
} as StreamFrame;

test("the stream opens after the last event, or from the start", () => {
  expect(streamUrl("ses_1", "evt_9")).toBe(
    "/api/sessions/ses_1/stream?after=evt_9"
  );
  expect(streamUrl("ses_1", null)).toBe(
    `/api/sessions/ses_1/stream?after=${FROM_START}`
  );
});

test("ids are escaped in the stream url", () => {
  expect(streamUrl("a/b", "x y")).toBe(
    "/api/sessions/a%2Fb/stream?after=x%20y"
  );
});

test("the page falls back after three failures in a row", () => {
  expect(shouldFallBack(MAX_FAILURES - 1, false)).toBe(false);
  expect(shouldFallBack(MAX_FAILURES, false)).toBe(true);
});

test("the page falls back at once when the stream is refused", () => {
  expect(shouldFallBack(1, true)).toBe(true);
});

test("parseFrame reads an event frame", () => {
  expect(parseFrame(JSON.stringify(eventFrame))).toEqual(eventFrame);
});

test("parseFrame reads a delta frame", () => {
  const frame = {
    frame: "delta",
    messageKey: "msg-1",
    runId: "run-1",
    text: "Hi",
  };
  expect(parseFrame(JSON.stringify(frame))).toEqual(frame as StreamFrame);
});

test("parseFrame reads a run frame", () => {
  const frame = { frame: "run", runId: "run-1", status: "waiting" };
  expect(parseFrame(JSON.stringify(frame))).toEqual(frame as StreamFrame);
});

test("parseFrame reads a ping frame", () => {
  expect(parseFrame(JSON.stringify({ frame: "ping" }))).toEqual({
    frame: "ping",
  });
});

test("parseFrame returns null for invalid JSON", () => {
  expect(parseFrame("{not json")).toBeNull();
});

test("parseFrame returns null for an unknown frame", () => {
  expect(parseFrame(JSON.stringify({ frame: "mystery" }))).toBeNull();
});
