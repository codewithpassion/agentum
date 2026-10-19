import { expect, test } from "bun:test";
import { canCancelFromLog, dayRangeFilters, isEventType } from "./log-logic.ts";

test("a day range runs from the start of the first day to the start of the day after the last", () => {
  expect(dayRangeFilters("2026-02-02", "2026-02-03")).toEqual({
    from: "2026-02-02T00:00:00.000Z",
    to: "2026-02-04T00:00:00.000Z",
  });
});

test("one end of the range can be open", () => {
  expect(dayRangeFilters("2026-02-02", undefined)).toEqual({
    from: "2026-02-02T00:00:00.000Z",
    to: undefined,
  });
  expect(dayRangeFilters(undefined, "2026-12-31")).toEqual({
    from: undefined,
    to: "2027-01-01T00:00:00.000Z",
  });
});

test("a value that is not a date is dropped", () => {
  expect(dayRangeFilters("soon", "2026-13-45")).toEqual({
    from: undefined,
    to: undefined,
  });
});

test("isEventType accepts known types only", () => {
  expect(isEventType("run.failed")).toBe(true);
  expect(isEventType("run.exploded")).toBe(false);
});

test("a day that rolls over is dropped", () => {
  expect(dayRangeFilters("2026-02-31", undefined)).toEqual({
    from: undefined,
    to: undefined,
  });
});

const RUN_ID = "r1";

test("canCancelFromLog offers Cancel on the opening events of an active run", () => {
  for (const runStatus of ["queued", "offered", "running"] as const) {
    for (const type of ["run.queued", "run.started"] as const) {
      expect(canCancelFromLog({ runId: RUN_ID, runStatus, type })).toBe(true);
    }
  }
});

test("canCancelFromLog hides Cancel once the run is over", () => {
  for (const runStatus of [
    "done",
    "failed",
    "cancelled",
    "interrupted",
  ] as const) {
    expect(
      canCancelFromLog({ runId: RUN_ID, runStatus, type: "run.started" })
    ).toBe(false);
  }
});

test("canCancelFromLog hides Cancel on the other events of a run", () => {
  expect(
    canCancelFromLog({
      runId: RUN_ID,
      runStatus: "running",
      type: "run.finished",
    })
  ).toBe(false);
  expect(
    canCancelFromLog({
      runId: RUN_ID,
      runStatus: "running",
      type: "message.user",
    })
  ).toBe(false);
});

test("canCancelFromLog hides Cancel on an event without a run", () => {
  expect(
    canCancelFromLog({ runId: null, runStatus: null, type: "run.started" })
  ).toBe(false);
  expect(
    canCancelFromLog({ runId: null, runStatus: "running", type: "run.started" })
  ).toBe(false);
});
