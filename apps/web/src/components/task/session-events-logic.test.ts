import { expect, test } from "bun:test";
import {
  FROM_START,
  MAX_FAILURES,
  shouldFallBack,
  streamUrl,
} from "./session-events-logic.ts";

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
