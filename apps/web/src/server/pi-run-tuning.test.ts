import { describe, expect, test } from "bun:test";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import {
  CONTEXT_BUDGET_COMPACTION_TOKENS,
  CONTEXT_BUDGETS,
} from "@repo/db/shared";
import { compactionPolicyFor } from "./pi-run-tuning";

const WINDOW = 1_000_000;

describe("compactionPolicyFor", () => {
  test("sets the reserve so each budget compacts at its table value", () => {
    for (const budget of CONTEXT_BUDGETS) {
      expect(compactionPolicyFor(budget, WINDOW)).toEqual({
        reserveTokens: WINDOW - CONTEXT_BUDGET_COMPACTION_TOKENS[budget],
      });
    }
  });

  test("returns Pi's defaults when the budget is unset", () => {
    expect(compactionPolicyFor(undefined, WINDOW)).toEqual({});
  });

  test("returns Pi's defaults when the window is unset", () => {
    expect(compactionPolicyFor("large", undefined)).toEqual({});
  });

  test("returns Pi's defaults when the window is zero, negative or not finite", () => {
    for (const window of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(compactionPolicyFor("standard", window)).toEqual({});
    }
  });

  test("keeps Pi's default reserve when the window is at or below the budget", () => {
    expect(compactionPolicyFor("large", 200_000)).toEqual({
      reserveTokens: DEFAULT_COMPACTION_POLICY.reserveTokens,
    });
  });

  test("a larger budget gives a smaller reserve, so it compacts later", () => {
    const small = compactionPolicyFor("small", WINDOW).reserveTokens;
    const large = compactionPolicyFor("large", WINDOW).reserveTokens;
    expect(large).toBeLessThan(small ?? Number.NEGATIVE_INFINITY);
  });
});
