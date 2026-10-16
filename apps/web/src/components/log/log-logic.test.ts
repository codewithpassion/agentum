import { expect, test } from "bun:test";
import { dayRangeFilters, isEventType } from "./log-logic.ts";

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
