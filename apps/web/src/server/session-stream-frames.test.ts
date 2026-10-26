import { expect, test } from "bun:test";
import { RUN_EVENT_TYPES } from "@repo/services/runs/types";
import {
  DESK_EVENT_TYPES,
  deskStreamName,
  STREAM_EVENT_TYPES,
  TASK_EVENT_TYPES,
} from "./session-stream-frames.ts";

test("reasoning is accepted from a run and carried on the stream", () => {
  expect(RUN_EVENT_TYPES).toContain("message.reasoning");
  expect(STREAM_EVENT_TYPES).toContain("message.reasoning");
});

test("a dry-run skip is carried on the session stream and the task view", () => {
  expect(STREAM_EVENT_TYPES).toContain("run.dry_run_skipped");
  expect(TASK_EVENT_TYPES).toContain("run.dry_run_skipped");
});

test("the desk stream leaves out a dry-run skip", () => {
  expect(DESK_EVENT_TYPES).not.toContain("run.dry_run_skipped");
});

test("the desk stream carries request and run events only", () => {
  expect(DESK_EVENT_TYPES).toContain("request.opened");
  expect(DESK_EVENT_TYPES).toContain("run.finished");
  for (const type of DESK_EVENT_TYPES) {
    expect(type.startsWith("message.") || type.startsWith("tool.")).toBe(false);
  }
});

test("a question asked or answered is carried on the session stream and the task view, not the desk", () => {
  for (const type of ["qa.asked", "qa.answered"] as const) {
    expect(STREAM_EVENT_TYPES).toContain(type);
    expect(TASK_EVENT_TYPES).toContain(type);
    expect(DESK_EVENT_TYPES).not.toContain(type);
  }
  expect(STREAM_EVENT_TYPES).not.toContain("qa.accepted");
});

test("the desk stream name is per workspace", () => {
  expect(deskStreamName("w1")).toBe("desk:w1");
});
