import { expect, test } from "bun:test";
import { decodeTime } from "ulidx";
import { incrementRandom, newEventId } from "./ids.ts";

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

test("incrementRandom carries across trailing Z digits", () => {
  expect(incrementRandom("0000000000009ZZZ")).toBe("000000000000A000");
});

test("incrementRandom rejects random part overflow", () => {
  expect(() => incrementRandom("Z".repeat(16))).toThrow(
    "ULID random part overflowed within one millisecond"
  );
});

test("newEventId strictly increases within millisecond zero", () => {
  const now = new Date(0);
  let previous = newEventId(now);
  for (let index = 0; index < 100; index += 1) {
    const id = newEventId(now);
    expect(id > previous).toBe(true);
    expect(decodeTime(id)).toBe(0);
    previous = id;
  }
});

test("newEventId produces unique bare ULIDs using the supplied time", () => {
  const now = new Date("2026-10-04T01:00:00Z");
  const first = newEventId(now);
  const second = newEventId(now);
  expect(first).toMatch(ULID_PATTERN);
  expect(second > first).toBe(true);
  expect(decodeTime(first)).toBe(now.getTime());
  expect(decodeTime(second)).toBe(now.getTime());
  expect(
    newEventId(new Date(now.getTime() + 1000)).slice(0, 10) > first.slice(0, 10)
  ).toBe(true);
  expect(newEventId()).toMatch(ULID_PATTERN);
});

test("newEventId preserves supplied times when time moves backwards", () => {
  const later = new Date("2030-01-01T00:00:00Z");
  const earlier = new Date("2020-01-01T00:00:00Z");
  for (const now of [later, earlier, later, earlier]) {
    expect(decodeTime(newEventId(now))).toBe(now.getTime());
  }
});

test("newEventId sorts consecutive same-millisecond IDs in generation order", () => {
  for (const ms of [Date.UTC(2030, 0, 1), Date.UTC(2020, 0, 1), 0]) {
    const ids = Array.from({ length: 100 }, () => newEventId(new Date(ms)));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids) {
      expect(decodeTime(id)).toBe(ms);
    }
  }
});

test("newEventId rejects an invalid Date", () => {
  expect(() => newEventId(new Date(Number.NaN))).toThrow("Invalid Date");
});
