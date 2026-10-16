import { expect, test } from "bun:test";
import {
  AGENT_STREAK_LIMIT,
  checkWakeRate,
  streakSuppressed,
  WAKE_LIMIT,
  WAKE_LIMIT_WINDOW_MS,
} from "./loop-guard.ts";

test("streak is suppressed when the newest posts are all agent posts", () => {
  expect(streakSuppressed(["agent", "agent", "agent"])).toBe(true);
});

test("streak is not suppressed with fewer entries than the limit", () => {
  expect(streakSuppressed(["agent", "agent"])).toBe(false);
  expect(streakSuppressed([])).toBe(false);
});

test("a user post among the newest entries lifts the suppression", () => {
  expect(streakSuppressed(["agent", "user", "agent"])).toBe(false);
  expect(streakSuppressed(["user", "agent", "agent"])).toBe(false);
});

test("older entries past the limit do not matter", () => {
  expect(streakSuppressed(["agent", "agent", "agent", "user"])).toBe(true);
});

test("the limit can be passed in", () => {
  expect(streakSuppressed(["agent", "agent"], 2)).toBe(true);
  expect(streakSuppressed(["agent", "agent", "agent"], 4)).toBe(false);
});

test("default streak limit is AGENT_STREAK_LIMIT", () => {
  expect(AGENT_STREAK_LIMIT).toBe(3);
  const agentRun = Array.from(
    { length: AGENT_STREAK_LIMIT - 1 },
    () => "agent" as const
  );
  expect(streakSuppressed(agentRun)).toBe(false);
  expect(streakSuppressed([...agentRun, "agent"])).toBe(true);
});

test("wake rate allows wakes up to the limit and records each one", () => {
  const options = { limit: 3, windowMs: 1000 };
  const first = checkWakeRate([], 0, options);
  const second = checkWakeRate(first.timestamps, 1, options);
  const third = checkWakeRate(second.timestamps, 2, options);

  expect([first.allowed, second.allowed, third.allowed]).toEqual([
    true,
    true,
    true,
  ]);
  expect(third.timestamps).toEqual([0, 1, 2]);
  expect(checkWakeRate(third.timestamps, 3, options).allowed).toBe(false);
});

test("wake rate forgets wakes that fell out of the window", () => {
  const check = checkWakeRate([0, 1, 2], 1002, { limit: 3, windowMs: 1000 });

  expect(check.allowed).toBe(true);
  expect(check.timestamps).toEqual([1002]);
});

test("a wake exactly windowMs old no longer counts", () => {
  const check = checkWakeRate([0, 0, 0], 1000, { limit: 3, windowMs: 1000 });

  expect(check.allowed).toBe(true);
  expect(check.timestamps).toEqual([1000]);
});

test("a wake just inside the window still counts", () => {
  const check = checkWakeRate([0, 0, 0], 999, { limit: 3, windowMs: 1000 });

  expect(check.allowed).toBe(false);
  expect(check.timestamps).toEqual([0, 0, 0]);
});

test("a denied check does not add its timestamp", () => {
  const check = checkWakeRate([0, 0, 0], 0, { limit: 3, windowMs: 1000 });

  expect(check.allowed).toBe(false);
  expect(check.timestamps).toEqual([0, 0, 0]);
});

test("wake rate defaults to WAKE_LIMIT within WAKE_LIMIT_WINDOW_MS", () => {
  const full = Array.from({ length: WAKE_LIMIT }, () => 0);

  expect(checkWakeRate(full, WAKE_LIMIT_WINDOW_MS - 1).allowed).toBe(false);
  expect(checkWakeRate(full, WAKE_LIMIT_WINDOW_MS).allowed).toBe(true);
});
