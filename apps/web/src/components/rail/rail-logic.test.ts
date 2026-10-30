import { expect, test } from "bun:test";
import { dueLabel, extraCardsLabel } from "./rail-logic.ts";

const now = new Date(2026, 9, 31, 10, 0);

function localIso(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0
): string {
  return new Date(year, monthIndex, day, hour, minute).toISOString();
}

test("a due day before today is overdue", () => {
  expect(dueLabel(localIso(2026, 9, 30, 17), now)).toBe("Overdue");
  expect(dueLabel(localIso(2026, 9, 24, 9), now)).toBe("Overdue");
});

test("a due day of today is due today, before or after the current hour", () => {
  expect(dueLabel(localIso(2026, 9, 31, 8), now)).toBe("Due today");
  expect(dueLabel(localIso(2026, 9, 31, 23, 30), now)).toBe("Due today");
});

test("the next calendar day is due tomorrow", () => {
  expect(dueLabel(localIso(2026, 4, 15, 9), new Date(2026, 4, 14, 10))).toBe(
    "Due tomorrow"
  );
});

test("the month boundary counts 31 Oct to 1 Nov as tomorrow", () => {
  expect(dueLabel(localIso(2026, 10, 1, 9), now)).toBe("Due tomorrow");
});

test("two to six days ahead gives a short weekday", () => {
  expect(dueLabel(localIso(2026, 10, 3, 9), now)).toBe("Due Tue");
  expect(dueLabel(localIso(2026, 10, 6, 9), now)).toBe("Due Fri");
});

test("seven or more days ahead in the same year gives day and month", () => {
  expect(dueLabel(localIso(2026, 10, 7, 9), now)).toBe("Due 7 Nov");
  expect(dueLabel(localIso(2026, 11, 30, 9), now)).toBe("Due 30 Dec");
});

test("a date in a later year includes the year", () => {
  expect(dueLabel(localIso(2027, 0, 15, 9), now)).toBe("Due 15 Jan 2027");
});

test("no due date gives no label", () => {
  expect(dueLabel(null, now)).toBeNull();
});

test("an unparseable due date gives no label", () => {
  expect(dueLabel("not a date", now)).toBeNull();
});

test("extra card label counts the cards behind the first", () => {
  expect(extraCardsLabel(0)).toBeNull();
  expect(extraCardsLabel(1)).toBeNull();
  expect(extraCardsLabel(2)).toBe("+1 more");
  expect(extraCardsLabel(5)).toBe("+4 more");
});
