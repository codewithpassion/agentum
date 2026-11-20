import { expect, test } from "bun:test";
import {
  CONTEXT_BUDGET_COMPACTION_TOKENS,
  CONTEXT_BUDGETS,
  contextBudgetOf,
  EFFORT_LEVELS,
  effortOf,
  runtimeConfigForRun,
} from "./shared.ts";

test("every context budget has a compaction threshold, and a larger budget compacts later", () => {
  const tokens = CONTEXT_BUDGETS.map(
    (budget) => CONTEXT_BUDGET_COMPACTION_TOKENS[budget]
  );
  expect(tokens.every((count) => count > 0)).toBe(true);
  expect(tokens).toEqual([...tokens].sort((a, b) => a - b));
});

test("effortOf reads each level and ignores anything else", () => {
  for (const level of EFFORT_LEVELS) {
    expect(effortOf({ effort: level })).toBe(level);
  }
  expect(effortOf({})).toBeUndefined();
  expect(effortOf({ effort: "extreme" })).toBeUndefined();
  expect(effortOf({ effort: 3 })).toBeUndefined();
});

test("contextBudgetOf reads each budget and ignores anything else", () => {
  for (const budget of CONTEXT_BUDGETS) {
    expect(contextBudgetOf({ contextBudget: budget })).toBe(budget);
  }
  expect(contextBudgetOf({})).toBeUndefined();
  expect(contextBudgetOf({ contextBudget: "huge" })).toBeUndefined();
});

test("runtimeConfigForRun keeps the config for a top-level run and drops the tuning for a subagent", () => {
  const config = {
    contextBudget: "small",
    effort: "high",
    maxTurns: 20,
  };
  expect(runtimeConfigForRun(config, 0)).toEqual(config);
  expect(runtimeConfigForRun(config, 1)).toEqual({ maxTurns: 20 });
  expect(config.effort).toBe("high");
});
