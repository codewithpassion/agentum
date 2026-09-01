import Anthropic from "@anthropic-ai/sdk";
import { parseCompletion } from "#/modules/runner/chat";
import { FAST_MODEL, FAST_WORKERS_AI_MODEL } from "./config";

/**
 * One-shot completions, for the small decisions taken while somebody waits.
 *
 * Deliberately not the gateway: that surface is Managed Agents - persisted
 * agents, sessions, environments - and none of that applies to a single
 * question with a one-line answer. This is the plain Messages API, or - when
 * the deployment runs without an Anthropic key at all - a small model on
 * Workers AI through the `AI` binding, so a workspace whose agents are all on
 * the Cloudflare runtime keeps thread addressing and the Slack thinking line.
 *
 * Every caller here is on a latency path and none of them is load-bearing, so
 * the contract is "an answer or nothing": a failure, a timeout or no backend
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
 * What the question may be asked of, in order of preference: an Anthropic key
 * when there is one, the `AI` binding otherwise. Both optional, because a
 * caller inside a workspace owes that workspace's key and may have none, and
 * a test env may carry no binding.
 */
export interface FastBackend {
  ai?: Ai | null;
  apiKey?: string | null;
}

const withTimeout = <T>(work: Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The fast model did not answer in time.")),
      TIMEOUT_MS
    );
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });

const askAnthropic = async (
  apiKey: string,
  input: FastAskInput
): Promise<string> => {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create(
    {
      max_tokens: input.maxTokens ?? MAX_TOKENS,
      messages: [{ content: input.prompt, role: "user" }],
      model: FAST_MODEL,
      system: input.system,
    },
    { timeout: TIMEOUT_MS }
  );
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
};

/** The binding's loosest overload: plain objects both ways. */
type AnyModelRun = (
  model: string,
  inputs: Record<string, unknown>
) => Promise<unknown>;

const askWorkersAi = async (ai: Ai, input: FastAskInput): Promise<string> => {
  const run = ai.run.bind(ai) as AnyModelRun;
  // Raced against the clock rather than cancelled: the binding takes no
  // signal, and a late answer to a question nobody is waiting on is harmless.
  const raw = await withTimeout(
    run(FAST_WORKERS_AI_MODEL, {
      max_tokens: input.maxTokens ?? MAX_TOKENS,
      messages: [
        { content: input.system, role: "system" },
        { content: input.prompt, role: "user" },
      ],
    })
  );
  return parseCompletion(raw).text;
};

/**
 * `null` when there is no backend, the call failed, or it took longer than
 * the answer is worth. Never throws: every call site has a fallback, and none
 * of them should have to hold a try/catch to reach it.
 */
export const askFast = async (
  backend: FastBackend,
  input: FastAskInput
): Promise<string | null> => {
  try {
    let text: string;
    if (backend.apiKey) {
      text = await askAnthropic(backend.apiKey, input);
    } else if (backend.ai) {
      text = await askWorkersAi(backend.ai, input);
    } else {
      return null;
    }
    return text.trim() || null;
  } catch {
    // Rate limits, timeouts, a bad key: all of them mean "no answer", and the
    // caller's fallback is always the behaviour we had before this existed.
    return null;
  }
};
