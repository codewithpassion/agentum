import { expect, test } from "bun:test";
import { priceTokens } from "./model-pricing.ts";

const NONE = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

test("prices input and output at the family's rates", () => {
  expect(
    priceTokens("claude-sonnet-5-5", {
      ...NONE,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
  ).toBe(18);
});

test("prices cache reads at a tenth and cache writes at 1.25 times the input rate", () => {
  expect(
    priceTokens("claude-opus-5-5", {
      ...NONE,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    })
  ).toBeCloseTo(0.5 + 6.25);
});

test("a model without rates has no price", () => {
  expect(priceTokens("gpt-9", { ...NONE, inputTokens: 5 })).toBeNull();
});
