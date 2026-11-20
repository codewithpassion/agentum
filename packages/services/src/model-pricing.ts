/**
 * What a model charges per million tokens, the one place a runtime prices
 * tokens when its provider reports no cost. A runtime that is told its cost
 * uses that instead; this only fills the gap. Ids match by family, so a dated
 * or newer id of the same family prices the same.
 *
 * Haiku's rates are Anthropic's first-party rates for claude-haiku-5-5 as of
 * 3 Nov 2026, for a prompt of up to 100K tokens (above that it charges $0.50 in
 * and $2.50 out, which this does not model, so a long prompt is undercounted).
 * The opus and sonnet rates are the first-party rates for claude-opus-5-5 and
 * claude-sonnet-5-5 as of 21 Nov 2026. Older ids of the same family (Opus 5 at
 * $5/$25, for one) are priced at the current rate.
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
  ["opus", { input: 4, output: 20 }],
  ["sonnet", { input: 2, output: 10 }],
  ["haiku", { input: 0.1, output: 0.5 }],
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
