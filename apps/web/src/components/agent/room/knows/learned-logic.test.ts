import { expect, test } from "bun:test";
import type { MemoryChange } from "@repo/db/shared";
import {
  changeSentence,
  changeWhen,
  learnedThisWeek,
  weekStartIso,
} from "./learned-logic.ts";

const DAY_MS = 86_400_000;
const NOW_MS = Date.UTC(2026, 10, 20, 12, 0, 0);
const WEEK_START_MS = NOW_MS - 7 * DAY_MS;

function change(overrides: Partial<MemoryChange>): MemoryChange {
  return {
    action: "add",
    agentId: "agent-1",
    createdAt: new Date(NOW_MS - DAY_MS).toISOString(),
    decidedAt: null,
    decidedBy: null,
    dreamRunId: null,
    groupId: null,
    id: "c-1",
    kind: "work",
    libraryVersionId: "v-1",
    noteId: "n-1",
    source: null,
    status: "applied",
    teamId: null,
    text: "Sort the inbox first.",
    userScope: null,
    writtenBy: "person",
    ...overrides,
  };
}

test("weekStartIso is exactly seven days before now", () => {
  expect(weekStartIso(NOW_MS)).toBe(new Date(WEEK_START_MS).toISOString());
});

test("learnedThisWeek keeps a change at exactly the window start", () => {
  const atStart = change({
    createdAt: new Date(WEEK_START_MS).toISOString(),
    id: "at",
  });
  const result = learnedThisWeek([atStart], NOW_MS, "tell_after");
  expect(result.map((c) => c.id)).toEqual(["at"]);
});

test("learnedThisWeek drops a change one millisecond before the window start", () => {
  const before = change({
    createdAt: new Date(WEEK_START_MS - 1).toISOString(),
    id: "before",
  });
  expect(learnedThisWeek([before], NOW_MS, "tell_after")).toEqual([]);
});

test("learnedThisWeek keeps only applied changes", () => {
  const changes = [
    change({ id: "applied", status: "applied" }),
    change({ id: "held", status: "held" }),
    change({ id: "rejected", status: "rejected" }),
    change({ id: "undone", status: "undone" }),
  ];
  const result = learnedThisWeek(changes, NOW_MS, "tell_after");
  expect(result.map((c) => c.id)).toEqual(["applied"]);
});

test("learnedThisWeek sorts newest first and breaks ties by id descending", () => {
  const older = change({
    createdAt: new Date(NOW_MS - 3 * DAY_MS).toISOString(),
    id: "a",
  });
  const newerLow = change({
    createdAt: new Date(NOW_MS - DAY_MS).toISOString(),
    id: "b",
  });
  const newerHigh = change({
    createdAt: new Date(NOW_MS - DAY_MS).toISOString(),
    id: "c",
  });
  const result = learnedThisWeek(
    [older, newerLow, newerHigh],
    NOW_MS,
    "tell_after"
  );
  expect(result.map((c) => c.id)).toEqual(["c", "b", "a"]);
});

test("learnedThisWeek hides agent and dream changes at quiet but keeps a person's", () => {
  const changes = [
    change({ id: "person", writtenBy: "person" }),
    change({ id: "agent", writtenBy: "agent" }),
    change({ id: "dream", writtenBy: "dream" }),
  ];
  const result = learnedThisWeek(changes, NOW_MS, "quiet");
  expect(result.map((c) => c.id)).toEqual(["person"]);
});

test("learnedThisWeek keeps agent and dream changes at ask_first and tell_after", () => {
  const changes = [
    change({
      createdAt: new Date(NOW_MS - 3 * DAY_MS).toISOString(),
      id: "person",
      writtenBy: "person",
    }),
    change({
      createdAt: new Date(NOW_MS - 2 * DAY_MS).toISOString(),
      id: "agent",
      writtenBy: "agent",
    }),
    change({
      createdAt: new Date(NOW_MS - DAY_MS).toISOString(),
      id: "dream",
      writtenBy: "dream",
    }),
  ];
  expect(
    learnedThisWeek(changes, NOW_MS, "ask_first").map((c) => c.id)
  ).toEqual(["dream", "agent", "person"]);
  expect(
    learnedThisWeek(changes, NOW_MS, "tell_after").map((c) => c.id)
  ).toEqual(["dream", "agent", "person"]);
});

test("learnedThisWeek does not mutate its input", () => {
  const changes = [
    change({ createdAt: new Date(NOW_MS - 3 * DAY_MS).toISOString(), id: "a" }),
    change({ createdAt: new Date(NOW_MS - DAY_MS).toISOString(), id: "b" }),
  ];
  const snapshot = changes.map((c) => c.id);
  learnedThisWeek(changes, NOW_MS, "tell_after");
  expect(changes.map((c) => c.id)).toEqual(snapshot);
});

test("changeSentence words each of the four actions", () => {
  expect(changeSentence({ action: "add", text: "Ana prefers mornings." })).toBe(
    "Remembered: Ana prefers mornings."
  );
  expect(
    changeSentence({ action: "edit", text: "Ana prefers evenings." })
  ).toBe("Changed a note to: Ana prefers evenings.");
  expect(changeSentence({ action: "forget", text: "Old address." })).toBe(
    "Forgot: Old address."
  );
  expect(changeSentence({ action: "merge", text: "Ana, Ben." })).toBe(
    "Merged notes into: Ana, Ben."
  );
});

test("changeWhen says today, yesterday, then the day count by local day", () => {
  const now = new Date(2026, 10, 20, 12, 0, 0).getTime();
  const at = (day: number, hour: number, minute = 0, second = 0) =>
    new Date(2026, 10, day, hour, minute, second).toISOString();
  expect(changeWhen(at(20, 0), now)).toBe("today");
  expect(changeWhen(at(19, 23, 59, 59), now)).toBe("yesterday");
  expect(changeWhen(at(18, 12), now)).toBe("2 days ago");
  expect(changeWhen(at(14, 23, 59, 59), now)).toBe("6 days ago");
});

test("learnedThisWeek leaves out merge rows and the rows a merge wrote", () => {
  const rows = [
    change({ action: "merge", id: "m1" }),
    change({ action: "forget", groupId: "m1", id: "f1" }),
    change({ id: "a1" }),
  ];
  expect(learnedThisWeek(rows, NOW_MS, "tell_after").map((c) => c.id)).toEqual([
    "a1",
  ]);
});
