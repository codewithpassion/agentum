import { expect, test } from "bun:test";
import { RUN_EVENT_TYPES } from "@repo/services/runs/types";
import { STREAM_EVENT_TYPES } from "./session-stream-frames.ts";

test("reasoning is accepted from a run and carried on the stream", () => {
  expect(RUN_EVENT_TYPES).toContain("message.reasoning");
  expect(STREAM_EVENT_TYPES).toContain("message.reasoning");
});
