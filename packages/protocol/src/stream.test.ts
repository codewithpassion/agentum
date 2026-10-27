import { describe, expect, test } from "bun:test";
import {
  deltaFrameSchema,
  eventFrameSchema,
  pingFrameSchema,
  requestFrameSchema,
  runFrameSchema,
  streamFrameSchema,
} from "./stream.ts";

const event = {
  actor: { id: "user_1", kind: "user" },
  createdAt: "2026-10-26T10:00:00.000Z",
  frame: "event",
  id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
  payload: { text: "hi" },
  runId: "run_1",
  seq: 3,
  type: "run.started",
};

describe("eventFrameSchema", () => {
  test("accepts an inline payload and a truncated payload", () => {
    expect(eventFrameSchema.safeParse(event).success).toBe(true);
    const { payload: _payload, ...rest } = event;
    expect(
      eventFrameSchema.safeParse({ ...rest, truncated: true }).success
    ).toBe(true);
  });

  test("refuses an unknown event type", () => {
    expect(
      eventFrameSchema.safeParse({ ...event, type: "run.exploded" }).success
    ).toBe(false);
  });

  test("refuses both payload and truncated, and neither", () => {
    const { payload: _payload, ...rest } = event;
    expect(
      eventFrameSchema.safeParse({ ...event, truncated: true }).success
    ).toBe(false);
    expect(eventFrameSchema.safeParse(rest).success).toBe(false);
  });
});

describe("deltaFrameSchema", () => {
  const delta = {
    frame: "delta",
    messageKey: "m1",
    runId: "run_1",
    text: "he",
  };

  test("accepts a good value", () => {
    expect(deltaFrameSchema.safeParse(delta).success).toBe(true);
  });

  test("refuses a delta without runId", () => {
    const { runId: _runId, ...rest } = delta;
    expect(deltaFrameSchema.safeParse(rest).success).toBe(false);
  });
});

describe("runFrameSchema", () => {
  test("accepts a good value and refuses an unknown status", () => {
    const run = { frame: "run", runId: "run_1", status: "running" };
    expect(runFrameSchema.safeParse(run).success).toBe(true);
    expect(
      runFrameSchema.safeParse({ ...run, status: "exploded" }).success
    ).toBe(false);
  });
});

describe("requestFrameSchema", () => {
  const request = {
    frame: "request",
    kind: "approval",
    requestId: "req_1",
    runId: "run_1",
    status: "pending",
  };

  test("accepts a good value and refuses an unknown kind", () => {
    expect(requestFrameSchema.safeParse(request).success).toBe(true);
    expect(
      requestFrameSchema.safeParse({ ...request, kind: "poll" }).success
    ).toBe(false);
  });
});

describe("pingFrameSchema and streamFrameSchema", () => {
  test("accepts each frame kind through the union", () => {
    const frames = [
      event,
      { frame: "delta", messageKey: "m1", runId: "run_1", text: "" },
      { frame: "run", runId: "run_1", status: "done" },
      {
        frame: "request",
        kind: "question",
        requestId: "req_1",
        runId: "run_1",
        status: "answered",
      },
      { frame: "ping" },
    ];
    for (const frame of frames) {
      expect(streamFrameSchema.safeParse(frame).success).toBe(true);
    }
    expect(pingFrameSchema.safeParse({ frame: "ping" }).success).toBe(true);
  });

  test("refuses an unknown frame name", () => {
    expect(streamFrameSchema.safeParse({ frame: "pong" }).success).toBe(false);
  });
});

test("trusted actor display is optional and carries only a name on both event variants", () => {
  expect(
    eventFrameSchema.parse({ ...event, actorDisplay: { name: "Ana" } })
      .actorDisplay
  ).toEqual({ name: "Ana" });
  const { payload: _payload, ...rest } = event;
  expect(
    eventFrameSchema.parse({
      ...rest,
      actorDisplay: { name: "Ana" },
      truncated: true,
    }).actorDisplay
  ).toEqual({ name: "Ana" });
  expect(
    eventFrameSchema.safeParse({
      ...event,
      actorDisplay: { email: "private@example.com", name: "Ana" },
    }).success
  ).toBe(false);
});
