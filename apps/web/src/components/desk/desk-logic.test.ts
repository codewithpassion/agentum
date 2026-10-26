import { expect, test } from "bun:test";
import {
  bandClass,
  cardLink,
  cardSubtitle,
  conflictStatusText,
  elapsedText,
  laneLabel,
  localMidnightIso,
  suggestionStatusText,
} from "./desk-logic.ts";

test("local midnight is the start of the local day, whatever the timezone", () => {
  const now = new Date(2026, 9, 26, 15, 30, 12);
  expect(localMidnightIso(now)).toBe(new Date(2026, 9, 26).toISOString());
  const endOfDay = new Date(2026, 9, 26, 23, 59, 59);
  expect(localMidnightIso(endOfDay)).toBe(new Date(2026, 9, 26).toISOString());
});

test("a thread card with a threadId links to the thread", () => {
  expect(
    cardLink({ kind: "thread", runId: "run_1", threadId: "thr_1" })
  ).toEqual({ kind: "thread", threadId: "thr_1" });
});

test("a thread card with only a runId does not link to the task", () => {
  expect(cardLink({ kind: "thread", runId: "run_1" })).toBeNull();
});

test("run and request cards link to their task", () => {
  expect(cardLink({ kind: "run", runId: "run_1" })).toEqual({
    kind: "task",
    runId: "run_1",
  });
  expect(cardLink({ kind: "request", runId: "run_2" })).toEqual({
    kind: "task",
    runId: "run_2",
  });
});

test("a proposal card links nowhere", () => {
  expect(cardLink({ kind: "proposal" })).toBeNull();
});

test("each band tone has its own non-empty class string", () => {
  const classes = [
    bandClass("ok"),
    bandClass("waiting"),
    bandClass("running"),
    bandClass("error"),
  ];
  for (const value of classes) {
    expect(value.length).toBeGreaterThan(0);
  }
  expect(new Set(classes).size).toBe(4);
});

test("elapsed time reads just now, then minutes, hours and days", () => {
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  expect(elapsedText("2026-10-26T11:59:30.000Z", now)).toBe("just now");
  expect(elapsedText("2026-10-26T11:55:00.000Z", now)).toBe("5 min ago");
  expect(elapsedText("2026-10-26T11:00:30.000Z", now)).toBe("59 min ago");
  expect(elapsedText("2026-10-26T10:00:00.000Z", now)).toBe("2 h ago");
  expect(elapsedText("2026-10-24T12:00:00.000Z", now)).toBe("2 d ago");
});

test("a future or unparsable time reads just now", () => {
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  expect(elapsedText("2026-10-26T13:00:00.000Z", now)).toBe("just now");
  expect(elapsedText("not a date", now)).toBe("just now");
});

test("the card subtitle joins agent, starter and elapsed time", () => {
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  expect(
    cardSubtitle(
      {
        agentName: "Researcher",
        at: "2026-10-26T11:00:00.000Z",
        startedBy: "Dom",
      },
      now
    )
  ).toBe("Researcher · started by Dom · 1 h ago");
});

test("each lane has its label", () => {
  expect(laneLabel("needs_you")).toBe("Needs you");
  expect(laneLabel("running")).toBe("Running");
  expect(laneLabel("done")).toBe("Done today");
});

test("a pending suggestion shows its summary", () => {
  expect(suggestionStatusText("pending", "Fix the intro")).toBe(
    "Fix the intro"
  );
});

test("a stale suggestion says the page changed and asks for an edit", () => {
  const text = suggestionStatusText("stale", "Fix the intro");
  expect(text).toContain("page changed");
  expect(text).toContain("edit it first");
  expect(text).not.toContain("Fix the intro");
});

test("a conflict card names the path and the choice", () => {
  const text = conflictStatusText("notes/a.md");
  expect(text).toContain("notes/a.md");
  expect(text).toContain("choose which to keep");
});
