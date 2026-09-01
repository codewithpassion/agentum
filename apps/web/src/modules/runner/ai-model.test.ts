import { describe, expect, test } from "bun:test";
import { createAiChatModel, gatewayFor } from "./ai-model";
import type { ChatRequest } from "./chat";

const request: ChatRequest = {
  maxTokens: 50,
  messages: [{ content: "hi", role: "user" }],
  model: "@cf/moonshotai/kimi-k2.5",
  system: "sys",
  tools: [],
};

describe("gatewayFor", () => {
  test("a Workers AI model goes direct unless a gateway is configured", () => {
    expect(gatewayFor("@cf/moonshotai/kimi-k2.5", undefined)).toBeUndefined();
    expect(gatewayFor("@cf/moonshotai/kimi-k2.5", "agentum")).toEqual({
      gateway: { id: "agentum" },
    });
  });

  test("a third-party model always goes through a gateway", () => {
    expect(gatewayFor("anthropic/claude-sonnet-4-5", undefined)).toEqual({
      gateway: { id: "default" },
    });
    expect(gatewayFor("openai/gpt-5.2", "agentum")).toEqual({
      gateway: { id: "agentum" },
    });
  });
});

describe("createAiChatModel", () => {
  test("runs the model through the binding and parses what comes back", async () => {
    const calls: unknown[][] = [];
    const ai = {
      run: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({
          choices: [{ finish_reason: "stop", message: { content: "Hello!" } }],
        });
      },
    } as unknown as Ai;

    const completion = await createAiChatModel(ai, {
      gatewayId: "agentum",
    }).complete(request);

    expect(completion.text).toBe("Hello!");
    expect(calls).toHaveLength(1);
    const [model, inputs, options] = calls[0] ?? [];
    expect(model).toBe("@cf/moonshotai/kimi-k2.5");
    expect(inputs).toMatchObject({
      max_tokens: 50,
      messages: [
        { content: "sys", role: "system" },
        { content: "hi", role: "user" },
      ],
    });
    expect(options).toEqual({ gateway: { id: "agentum" } });
  });

  test("passes no options when a Workers AI model has no gateway", async () => {
    const calls: unknown[][] = [];
    const ai = {
      run: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ response: "ok" });
      },
    } as unknown as Ai;

    await createAiChatModel(ai).complete(request);

    expect(calls[0]?.[2]).toBeUndefined();
  });
});
