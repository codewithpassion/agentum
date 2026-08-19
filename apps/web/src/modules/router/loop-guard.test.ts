import { describe, expect, test } from "bun:test";
import { AGENT_STREAK_LIMIT } from "./config";
import {
  checkWakeRate,
  emptyChannelGuard,
  nextChannelGuard,
} from "./loop-guard";

const runAgentMessages = (count: number) => {
  let guard = emptyChannelGuard();
  for (let index = 0; index < count; index += 1) {
    guard = nextChannelGuard(guard, "agent");
  }
  return guard;
};

describe("nextChannelGuard", () => {
  test("stays open while agents talk below the limit", () => {
    expect(runAgentMessages(AGENT_STREAK_LIMIT - 1).suppressed).toBe(false);
  });

  test("closes once the agent-only streak reaches the limit", () => {
    const guard = runAgentMessages(AGENT_STREAK_LIMIT);

    expect(guard.suppressed).toBe(true);
    expect(guard.agentStreak).toBe(AGENT_STREAK_LIMIT);
  });

  test("a human message reopens the channel and resets the streak", () => {
    const reopened = nextChannelGuard(
      runAgentMessages(AGENT_STREAK_LIMIT),
      "user"
    );

    expect(reopened).toEqual({ agentStreak: 0, suppressed: false });
  });

  test("a message from an external surface counts as a human one", () => {
    expect(
      nextChannelGuard(runAgentMessages(AGENT_STREAK_LIMIT), "external")
        .suppressed
    ).toBe(false);
  });
});

describe("checkWakeRate", () => {
  const options = { limit: 3, windowMs: 1000 };

  test("allows wakes up to the limit and records each one", () => {
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

  test("forgets wakes that fell out of the window", () => {
    const check = checkWakeRate([0, 1, 2], 1002, options);

    expect(check.allowed).toBe(true);
    expect(check.timestamps).toEqual([1002]);
  });

  test("leaves the window untouched when the wake is refused", () => {
    const check = checkWakeRate([0, 0, 0], 0, options);

    expect(check.allowed).toBe(false);
    expect(check.timestamps).toEqual([0, 0, 0]);
  });
});
