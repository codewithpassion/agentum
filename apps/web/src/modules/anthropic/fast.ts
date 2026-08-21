import Anthropic from "@anthropic-ai/sdk";
import { FAST_MODEL } from "./config";

/**
 * One-shot completions, for the small decisions taken while somebody waits.
 *
 * Deliberately not the gateway: that surface is Managed Agents - persisted
 * agents, sessions, environments - and none of that applies to a single
 * question with a one-line answer. This is the plain Messages API.
 *
 * Every caller here is on a latency path and none of them is load-bearing, so
 * the contract is "an answer or nothing": a failure, a timeout or a missing key
 * returns `null` and the caller falls back to what it would have done anyway.
 */

/** Long enough for a sentence, short enough that a runaway answer is capped. */
const MAX_TOKENS = 128;

/** Past this the answer is no longer worth having - the human is still waiting. */
const TIMEOUT_MS = 4000;

export interface FastAskInput {
  /** Caps the answer. Defaults to a sentence's worth. */
  maxTokens?: number;
  prompt: string;
  system: string;
}

/**
 * `null` when the integration is off, the call failed, or it took longer than
 * the answer is worth. Never throws: every call site has a fallback, and none
 * of them should have to hold a try/catch to reach it.
 */
export const askFast = async (
  env: Env,
  input: FastAskInput
): Promise<string | null> => {
  if (!env.ANTHROPIC_API_KEY) {
    return null;
  }

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create(
      {
        max_tokens: input.maxTokens ?? MAX_TOKENS,
        messages: [{ content: input.prompt, role: "user" }],
        model: FAST_MODEL,
        system: input.system,
      },
      { timeout: TIMEOUT_MS }
    );

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    return text || null;
  } catch {
    // Rate limits, timeouts, a bad key: all of them mean "no answer", and the
    // caller's fallback is always the behaviour we had before this existed.
    return null;
  }
};
