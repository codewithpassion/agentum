import { describe, expect, test } from "bun:test";
import { freeSlots, type PlanInput, planWakes } from "./plan";
import type { WakeTarget } from "./wake-decision";

const immediate = (agentId: string): WakeTarget => ({
  agentId,
  kind: "immediate",
});

const input = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  activeSessions: 0,
  hasLiveSession: () => false,
  isWithinRate: () => true,
  maxActiveSessions: 2,
  suppressed: false,
  targets: [immediate("cos")],
  ...overrides,
});

const actionFor = (
  planned: ReturnType<typeof planWakes>,
  agentId: string
): string | undefined =>
  planned.find((entry) => entry.agentId === agentId)?.action;

describe("planWakes", () => {
  test("wakes an immediate target when a slot is free", () => {
    expect(actionFor(planWakes(input()), "cos")).toBe("wake");
  });

  test("queues immediate targets once the session cap is reached", () => {
    const planned = planWakes(
      input({
        activeSessions: 2,
        targets: [immediate("cos"), immediate("researcher")],
      })
    );

    expect(actionFor(planned, "cos")).toBe("queue");
    expect(actionFor(planned, "researcher")).toBe("queue");
  });

  test("counts the sessions it plans to start against the cap", () => {
    const planned = planWakes(
      input({
        activeSessions: 1,
        targets: [immediate("a"), immediate("b"), immediate("c")],
      })
    );

    expect(planned.map((entry) => entry.action)).toEqual([
      "wake",
      "queue",
      "queue",
    ]);
  });

  test("sending into a live session costs no slot", () => {
    const planned = planWakes(
      input({
        activeSessions: 2,
        hasLiveSession: (agentId) => agentId === "cos",
        targets: [immediate("cos")],
      })
    );

    expect(actionFor(planned, "cos")).toBe("wake");
  });

  test("defers a rate-limited mention to the digest instead of dropping it", () => {
    const planned = planWakes(input({ isWithinRate: () => false }));

    expect(actionFor(planned, "cos")).toBe("digest");
  });

  test("suppresses everything in a channel stuck in an agent-only loop", () => {
    const planned = planWakes(
      input({
        suppressed: true,
        targets: [immediate("cos"), { agentId: "researcher", kind: "digest" }],
      })
    );

    expect(planned.map((entry) => entry.action)).toEqual([
      "suppressed",
      "suppressed",
    ]);
  });

  test("digest targets never take a session slot", () => {
    const planned = planWakes(
      input({
        activeSessions: 2,
        targets: [{ agentId: "cos", kind: "digest" }],
      })
    );

    expect(actionFor(planned, "cos")).toBe("digest");
  });
});

describe("freeSlots", () => {
  test("never goes negative", () => {
    expect(freeSlots(9, 5)).toBe(0);
    expect(freeSlots(3, 5)).toBe(2);
  });
});
