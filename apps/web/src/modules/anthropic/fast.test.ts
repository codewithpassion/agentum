import { describe, expect, test } from "bun:test";
import { askFast } from "./fast";

/**
 * The contract every caller leans on: no key means no answer, and no throw.
 * Nothing here reaches the network - a call with a key is the one case this
 * cannot exercise offline, and the SDK is faked where that matters.
 */

const INPUT = { prompt: "Who is this for?", system: "Answer in one word." };

describe("askFast", () => {
  test("answers null rather than calling out when there is no key", async () => {
    // The Slack bridge's thinking line passes `env.ANTHROPIC_API_KEY` straight
    // through, so an unset variable arrives as each of these.
    expect(await askFast(null, INPUT)).toBe(null);
    expect(await askFast(undefined, INPUT)).toBe(null);
    expect(await askFast("", INPUT)).toBe(null);
  });
});
