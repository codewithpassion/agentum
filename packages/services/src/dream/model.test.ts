import { expect, test } from "bun:test";
import { createDreamModel, DREAM_PRICE_PER_MILLION } from "./model.ts";
import { defined } from "./test-dream.ts";

const reply = (body: unknown, status = 200) =>
  Promise.resolve(Response.json(body, { status }));

test("a call goes to the Messages API on the dream model with the workspace's key and adds up usage", async () => {
  const seen: { body: Record<string, unknown>; key: string | undefined }[] = [];
  const model = createDreamModel({
    apiKey: "sk-ant-test",
    fetch: (_url, init) => {
      seen.push({
        body: JSON.parse(String(init?.body)),
        key: new Headers(init?.headers).get("x-api-key") ?? undefined,
      });
      return reply({
        content: [
          { text: "hello ", type: "text" },
          { text: "there", type: "text" },
        ],
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      });
    },
  });
  expect(await model.judge("prompt", "system")).toBe("hello there");
  expect(defined(seen[0]).key).toBe("sk-ant-test");
  expect(defined(seen[0]).body.model).toBe("claude-haiku-5-5");
  expect(defined(seen[0]).body.system).toBe("system");
  expect(model.failedCalls()).toBe(0);
  expect(model.usage()).toEqual({
    costUsd: DREAM_PRICE_PER_MILLION.input + DREAM_PRICE_PER_MILLION.output,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
});

test("a failed request, an error status and an empty reply are counted and answer null", async () => {
  let call = 0;
  const model = createDreamModel({
    apiKey: "sk-ant-secret",
    fetch: () => {
      call += 1;
      if (call === 1) {
        return Promise.reject(new Error("network down sk-ant-secret"));
      }
      return call === 2 ? reply({}, 529) : reply({ content: [] });
    },
  });
  expect(await model.judge("p", "s")).toBeNull();
  expect(await model.judge("p", "s")).toBeNull();
  expect(await model.judge("p", "s")).toBeNull();
  expect(model.failedCalls()).toBe(3);
});
