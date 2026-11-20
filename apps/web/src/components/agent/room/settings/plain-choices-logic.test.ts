import { expect, test } from "bun:test";
import { CONTEXT_BUDGETS, EFFORT_LEVELS } from "@repo/db/shared";
import type { RuntimeConfig } from "@repo/services/agents";
import {
  CAPABILITY_CHOICES,
  CONTEXT_CHOICES,
  capabilityOf,
  contextOf,
  NOT_SET,
  THINKING_CHOICES,
  thinkingOf,
  withContextBudget,
  withEffort,
} from "./plain-choices-logic.ts";

const config = (value: Record<string, unknown>): RuntimeConfig =>
  value as RuntimeConfig;

test("capabilityOf reads the tier from an alias or a full Anthropic id", () => {
  expect(capabilityOf("sonnet")).toBe("sonnet");
  expect(capabilityOf("Opus")).toBe("opus");
  expect(capabilityOf(" haiku ")).toBe("haiku");
  expect(capabilityOf("claude-opus-5-5")).toBe("opus");
  expect(capabilityOf("claude-haiku-5-5")).toBe("haiku");
  expect(capabilityOf("claude-sonnet-5-5")).toBe("sonnet");
});

test("capabilityOf is null for a model that is not one of the three tiers", () => {
  expect(capabilityOf("openrouter:z-ai/glm-5.3")).toBeNull();
  expect(capabilityOf("something-else")).toBeNull();
  expect(capabilityOf("")).toBeNull();
});

test("thinkingOf returns the saved level, or NOT_SET when none is valid", () => {
  expect(thinkingOf({})).toBe(NOT_SET);
  expect(thinkingOf({ effort: "high" })).toBe("high");
  expect(thinkingOf({ effort: "low" })).toBe("low");
  expect(thinkingOf({ effort: "extreme" })).toBe(NOT_SET);
  expect(thinkingOf({ effort: 3 })).toBe(NOT_SET);
  expect(thinkingOf({ effort: null })).toBe(NOT_SET);
});

test("contextOf returns the saved budget, or NOT_SET when none is valid", () => {
  expect(contextOf({})).toBe(NOT_SET);
  expect(contextOf({ contextBudget: "large" })).toBe("large");
  expect(contextOf({ contextBudget: "small" })).toBe("small");
  expect(contextOf({ contextBudget: "huge" })).toBe(NOT_SET);
  expect(contextOf({ contextBudget: 1 })).toBe(NOT_SET);
});

test("withEffort sets, replaces and removes the level", () => {
  expect(withEffort(config({}), "medium")).toEqual({ effort: "medium" });
  expect(withEffort(config({ effort: "low" }), "high")).toEqual({
    effort: "high",
  });
  const removed = withEffort(config({ effort: "low" }), NOT_SET);
  expect("effort" in removed).toBe(false);
});

test("withEffort ignores a value that is not an effort level", () => {
  const before = config({ effort: "low", maxTurns: 20 });
  expect(withEffort(before, "extreme")).toEqual({
    effort: "low",
    maxTurns: 20,
  });
  expect(withEffort(config({}), "3")).toEqual({});
});

test("withEffort keeps unrelated keys and does not mutate its input", () => {
  const before = config({
    contextBudget: "large",
    effort: "low",
    maxTurns: 20,
  });
  const snapshot = JSON.stringify(before);
  const after = withEffort(before, "high");
  expect(after).toEqual({
    contextBudget: "large",
    effort: "high",
    maxTurns: 20,
  });
  expect(JSON.stringify(before)).toBe(snapshot);
  expect(withEffort(before, NOT_SET)).toEqual({
    contextBudget: "large",
    maxTurns: 20,
  });
  expect(JSON.stringify(before)).toBe(snapshot);
  expect(withEffort(before, "extreme")).not.toBe(before);
});

test("withContextBudget sets, replaces and removes the budget", () => {
  expect(withContextBudget(config({}), "standard")).toEqual({
    contextBudget: "standard",
  });
  expect(
    withContextBudget(config({ contextBudget: "small" }), "large")
  ).toEqual({ contextBudget: "large" });
  const removed = withContextBudget(
    config({ contextBudget: "small" }),
    NOT_SET
  );
  expect("contextBudget" in removed).toBe(false);
});

test("withContextBudget ignores a value that is not a context budget", () => {
  const before = config({ contextBudget: "small", maxTurns: 20 });
  expect(withContextBudget(before, "huge")).toEqual({
    contextBudget: "small",
    maxTurns: 20,
  });
});

test("withContextBudget keeps unrelated keys and does not mutate its input", () => {
  const before = config({ effort: "high", maxTurns: 20 });
  const snapshot = JSON.stringify(before);
  expect(withContextBudget(before, "small")).toEqual({
    contextBudget: "small",
    effort: "high",
    maxTurns: 20,
  });
  expect(withContextBudget(before, NOT_SET)).toEqual({
    effort: "high",
    maxTurns: 20,
  });
  expect(JSON.stringify(before)).toBe(snapshot);
});

test("capability choices are in order opus, sonnet, haiku", () => {
  expect(CAPABILITY_CHOICES.map((choice) => choice.value)).toEqual([
    "opus",
    "sonnet",
    "haiku",
  ]);
});

test("thinking choices cover every effort level exactly once", () => {
  expect(THINKING_CHOICES.map((choice) => choice.value)).toEqual([
    ...EFFORT_LEVELS,
  ]);
});

test("context choices cover every context budget exactly once", () => {
  expect(CONTEXT_CHOICES.map((choice) => choice.value)).toEqual([
    ...CONTEXT_BUDGETS,
  ]);
});
