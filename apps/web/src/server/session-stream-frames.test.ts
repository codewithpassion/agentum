import { expect, test } from "bun:test";
import { RUN_EVENT_TYPES } from "@repo/services/runs/types";
import {
  DESK_EVENT_TYPES,
  deskStreamName,
  STREAM_EVENT_TYPES,
} from "./session-stream-frames.ts";

test("reasoning is accepted from a run and carried on the stream", () => {
  expect(RUN_EVENT_TYPES).toContain("message.reasoning");
  expect(STREAM_EVENT_TYPES).toContain("message.reasoning");
});

test("the desk stream carries request and run events only", () => {
  expect(DESK_EVENT_TYPES).toContain("request.opened");
  expect(DESK_EVENT_TYPES).toContain("run.finished");
  for (const type of DESK_EVENT_TYPES) {
    expect(type.startsWith("message.") || type.startsWith("tool.")).toBe(false);
  }
});

test("the desk stream name is per workspace", () => {
  expect(deskStreamName("w1")).toBe("desk:w1");
});
