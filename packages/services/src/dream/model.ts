// The dream's model calls: Anthropic's Messages API on the workspace's own key,
// through the same `fetch` and endpoint the agent builder uses, on
// `DREAM_MODEL`. The steps take a `Judge` and nothing else. A call that fails
// is counted, not thrown, because the steps degrade on a null answer. The run
// reads `failedCalls` afterwards and fails when it is not zero, so a dream
// never writes a plan that part of the model's work is missing from.
import { DREAM_MODEL, type DreamUsage } from "@repo/db/shared";
import type { Fetcher } from "../connectors/mcp.ts";
import type { Judge } from "./steps/judge.ts";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;
const CALL_TIMEOUT_MS = 90_000;
const MILLION = 1_000_000;

/**
 * USD per million tokens of `DREAM_MODEL` (claude-haiku-5-5), for the cost a
 * dream reports to the spend rollups. These are the rates for a prompt of up
 * to 100K tokens. Above 100K tokens Anthropic charges $0.50 in and $2.50 out
 * (first-party rates as of 3 Nov 2026). A dream's evidence is capped at 100K
 * characters, so a prompt is normally well under that. Dense non-English text
 * could pass it, and such a call would be undercounted.
 */
export const DREAM_PRICE_PER_MILLION = { input: 0.1, output: 0.5 } as const;

interface MessagesResponse {
  content?: { text?: string; type: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface DreamModel {
  /** How many calls failed: a network error, a non-success status or an empty reply. */
  failedCalls: () => number;
  /** The extraction call and the three steps' judges all go through this. */
  judge: Judge;
  /** What the calls used so far. */
  usage: () => DreamUsage;
}

export const createDreamModel = ({
  apiKey,
  fetch: fetcher,
}: {
  apiKey: string;
  fetch: Fetcher;
}): DreamModel => {
  let failed = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const judge: Judge = async (prompt, system) => {
    try {
      const response = await fetcher(MESSAGES_URL, {
        body: JSON.stringify({
          max_tokens: MAX_TOKENS,
          messages: [{ content: prompt, role: "user" }],
          model: DREAM_MODEL,
          system,
        }),
        headers: {
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        method: "POST",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!response.ok) {
        failed += 1;
        return null;
      }
      const body = (await response.json()) as MessagesResponse;
      inputTokens += body.usage?.input_tokens ?? 0;
      outputTokens += body.usage?.output_tokens ?? 0;
      const text = (body.content ?? [])
        .flatMap((block) =>
          block.type === "text" && block.text ? [block.text] : []
        )
        .join("");
      if (text === "") {
        failed += 1;
        return null;
      }
      return text;
    } catch {
      // A network error can quote the request, and so the key: its words stay out.
      failed += 1;
      return null;
    }
  };

  return {
    failedCalls: () => failed,
    judge,
    usage: () => ({
      costUsd:
        (inputTokens * DREAM_PRICE_PER_MILLION.input +
          outputTokens * DREAM_PRICE_PER_MILLION.output) /
        MILLION,
      inputTokens,
      outputTokens,
    }),
  };
};
