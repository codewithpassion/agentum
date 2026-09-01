import { describe, expect, test } from "bun:test";
import { askFast } from "./fast";

/**
 * The contract every caller leans on: no backend means no answer, and no
 * throw. The Anthropic branch is the one case this cannot exercise offline;
 * the Workers AI branch is driven through a fake binding.
 */

const INPUT = { prompt: "Who is this for?", system: "Answer in one word." };

const fakeAi = (answer: () => unknown) => {
  const calls: { inputs: Record<string, unknown>; model: string }[] = [];
  const ai = {
    run: (model: string, inputs: Record<string, unknown>) => {
      calls.push({ inputs, model });
      return Promise.resolve(answer());
    },
  } as unknown as Ai;
  return { ai, calls };
};

describe("askFast", () => {
  test("answers null rather than calling out when there is no backend", async () => {
    // The Slack bridge's thinking line passes `env.ANTHROPIC_API_KEY` straight
    // through, so an unset variable arrives as each of these.
    expect(await askFast({}, INPUT)).toBe(null);
    expect(await askFast({ apiKey: null }, INPUT)).toBe(null);
    expect(await askFast({ ai: null, apiKey: "" }, INPUT)).toBe(null);
  });

  test("asks Workers AI when there is a binding and no key", async () => {
    const { ai, calls } = fakeAi(() => ({ response: "  Researcher \n" }));

    expect(await askFast({ ai, apiKey: "" }, INPUT)).toBe("Researcher");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("@cf/meta/llama-3.1-8b-instruct-fp8");
    expect(calls[0]?.inputs).toEqual({
      max_tokens: 128,
      messages: [
        { content: "Answer in one word.", role: "system" },
        { content: "Who is this for?", role: "user" },
      ],
    });
  });

  test("reads a chat-completions answer from the binding too", async () => {
    const { ai } = fakeAi(() => ({
      choices: [{ finish_reason: "stop", message: { content: "Ops" } }],
    }));

    expect(await askFast({ ai }, INPUT)).toBe("Ops");
  });

  test("a failing or empty binding answer is null, not a throw", async () => {
    const failing = {
      run: () => Promise.reject(new Error("503")),
    } as unknown as Ai;
    expect(await askFast({ ai: failing }, INPUT)).toBe(null);

    const { ai } = fakeAi(() => ({ response: "   " }));
    expect(await askFast({ ai }, INPUT)).toBe(null);
  });
});
