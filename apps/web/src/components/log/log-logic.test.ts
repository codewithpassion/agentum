import { expect, test } from "bun:test";
import { cancelEntryIds, dayRangeFilters, isEventType } from "./log-logic.ts";

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

type Entry = Parameters<typeof cancelEntryIds>[0][number];

const entry = (
  id: string,
  runId: string | null,
  runStatus: Entry["runStatus"],
  type: Entry["type"]
): Entry => ({ id, runId, runStatus, type });

test("a run with a queued and a started row gives Cancel to the newer one only", () => {
  const entries = [
    entry("started", "r1", "running", "run.started"),
    entry("queued", "r1", "running", "run.queued"),
  ];
  expect(cancelEntryIds(entries)).toEqual(new Set(["started"]));
});

test("two active runs each get Cancel once", () => {
  const entries = [
    entry("a2", "a", "running", "run.started"),
    entry("b1", "b", "queued", "run.queued"),
    entry("a1", "a", "running", "run.queued"),
  ];
  expect(cancelEntryIds(entries)).toEqual(new Set(["a2", "b1"]));
});

test("a run that is over gets no Cancel", () => {
  for (const runStatus of [
    "done",
    "failed",
    "cancelled",
    "interrupted",
  ] as const) {
    expect(
      cancelEntryIds([entry("s", "r1", runStatus, "run.started")])
    ).toEqual(new Set());
  }
});

test("an entry without a run gets no Cancel", () => {
  expect(cancelEntryIds([entry("s", null, null, "run.started")])).toEqual(
    new Set()
  );
  expect(cancelEntryIds([entry("s", null, "running", "run.started")])).toEqual(
    new Set()
  );
});

test("an event that does not open a run gets no Cancel", () => {
  expect(
    cancelEntryIds([entry("m", "r1", "running", "message.assistant")])
  ).toEqual(new Set());
});

test("Cancel moves to the opening event when a newer event of the run is not one", () => {
  const entries = [
    entry("m", "r1", "running", "message.assistant"),
    entry("s", "r1", "running", "run.started"),
  ];
  expect(cancelEntryIds(entries)).toEqual(new Set(["s"]));
});
