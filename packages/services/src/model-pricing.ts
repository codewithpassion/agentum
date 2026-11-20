/**
 * What a model charges per million tokens, the one place a runtime prices
 * tokens when its provider reports no cost. A runtime that is told its cost
 * uses that instead; this only fills the gap. Ids match by family, so a dated
 * or newer id of the same family prices the same.
 */

export interface TokenCounts {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  outputTokens: number;
}

interface Rates {
  /** USD per million input tokens. Cache reads and writes derive from it. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

const FAMILY_RATES: readonly (readonly [string, Rates])[] = [
  ["opus", { input: 5, output: 25 }],
  ["sonnet", { input: 3, output: 15 }],
  ["haiku", { input: 1, output: 5 }],
];

const TOKENS_PER_RATE = 1_000_000;
const CACHE_READ_FACTOR = 0.1;
const CACHE_WRITE_FACTOR = 1.25;

/** USD for the tokens, or null when the model's family has no rates here. */
export const priceTokens = (
  model: string,
  tokens: TokenCounts
): number | null => {
  const id = model.toLowerCase();
  const rates = FAMILY_RATES.find(([family]) => id.includes(family))?.[1];
  if (!rates) {
    return null;
  }
  const inputDollars =
    tokens.inputTokens +
    tokens.cacheReadTokens * CACHE_READ_FACTOR +
    tokens.cacheWriteTokens * CACHE_WRITE_FACTOR;
  return (
    (inputDollars * rates.input + tokens.outputTokens * rates.output) /
    TOKENS_PER_RATE
  );
};
