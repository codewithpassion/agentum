import { expect, test } from "bun:test";
import type { Context } from "@earendil-works/pi-ai";
import { guestInference } from "./guest-run-inference";
import { createCloudModels } from "./pi-run-models";

test("production guest inference transport passes only scoped data and no native tools", async () => {
  let captured: Context | undefined;
  let provider: string | undefined;
  const infer = guestInference(
    (name) => {
      provider = name;
      return Promise.resolve("fixture-key");
    },
    (store) => {
      const models = createCloudModels(store);
      models.complete = async (model, context) => {
        await store.read(model.provider);
        captured = context;
        return {
          api: model.api,
          content: [
            {
              text: JSON.stringify({ kind: "answer", text: "local model" }),
              type: "text",
            },
          ],
          model: model.id,
          provider: model.provider,
          role: "assistant",
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: {
              cacheRead: 0,
              cacheWrite: 0,
              input: 0,
              output: 0,
              total: 0,
            },
            input: 1,
            output: 1,
            totalTokens: 2,
          },
        };
      };
      return models;
    }
  );
  expect(
    await infer({
      context: "shared history",
      history: [],
      model: "openrouter:z-ai/glm-5.3",
      text: "guest envelope",
      tools: [{ inputSchema: { artifactId: "exact" }, name: "document_read" }],
    })
  ).toEqual({ kind: "answer", text: "local model" });
  expect(provider).toBe("openrouter");
  expect(captured?.tools).toBeUndefined();
  expect(captured?.messages).toHaveLength(1);
  expect(JSON.stringify(captured)).toContain("shared history");
  expect(JSON.stringify(captured)).not.toContain("fixture-key");
});
