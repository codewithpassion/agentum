import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { serve } from "bun";
import { NO_KEY_MESSAGE, workspaceKeyStore } from "./pi-run-credentials.ts";
import { createCloudModels } from "./pi-run-models.ts";

const KEY = "sk-ant-test-key-1234";
const ENV_KEY = "sk-ant-env-key-should-not-be-used";

const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const STREAM = [
  sse("message_start", {
    message: {
      content: [],
      id: "msg_test",
      model: "claude-sonnet-5-5",
      role: "assistant",
      stop_reason: null,
      stop_sequence: null,
      type: "message",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    type: "message_start",
  }),
  sse("content_block_start", {
    content_block: { text: "", type: "text" },
    index: 0,
    type: "content_block_start",
  }),
  sse("content_block_delta", {
    delta: { text: "pelican", type: "text_delta" },
    index: 0,
    type: "content_block_delta",
  }),
  sse("content_block_stop", { index: 0, type: "content_block_stop" }),
  sse("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    type: "message_delta",
    usage: { output_tokens: 1 },
  }),
  sse("message_stop", { type: "message_stop" }),
].join("");

const context: Context = {
  messages: [{ content: "hi", role: "user", timestamp: Date.now() }],
};

describe("workspaceKeyStore", () => {
  test("read returns the key from resolveKey", async () => {
    const store = workspaceKeyStore(async () => KEY);
    expect(await store.read("anthropic")).toEqual({
      key: KEY,
      type: "api_key",
    });
  });

  test("read of another provider is undefined", async () => {
    const store = workspaceKeyStore(async () => KEY);
    expect(await store.read("openai")).toBeUndefined();
  });

  test("a null key makes read throw NO_KEY_MESSAGE", async () => {
    const store = workspaceKeyStore(async () => null);
    await expect(store.read("anthropic")).rejects.toThrow(NO_KEY_MESSAGE);
  });

  test("resolveKey is called on every read", async () => {
    let calls = 0;
    const store = workspaceKeyStore(() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? "sk-ant-first" : "sk-ant-rotated");
    });
    expect(await store.read("anthropic")).toEqual({
      key: "sk-ant-first",
      type: "api_key",
    });
    expect(await store.read("anthropic")).toEqual({
      key: "sk-ant-rotated",
      type: "api_key",
    });
    expect(calls).toBe(2);
  });

  test("modify and delete reject", async () => {
    const store = workspaceKeyStore(async () => KEY);
    await expect(
      store.modify("anthropic", () =>
        Promise.resolve({ key: "sk-ant-new", type: "api_key" })
      )
    ).rejects.toThrow("Settings");
    await expect(store.delete("anthropic")).rejects.toThrow("Settings");
  });

  test("list is empty", async () => {
    expect(await workspaceKeyStore(async () => KEY).list()).toEqual([]);
  });
});

describe("cloud models against a fake Anthropic server", () => {
  let server: ReturnType<typeof serve>;
  let requests: { path: string; apiKey: string | null }[] = [];

  beforeAll(() => {
    server = serve({
      fetch(request) {
        const url = new URL(request.url);
        requests.push({
          apiKey: request.headers.get("x-api-key"),
          path: url.pathname,
        });
        return new Response(STREAM, {
          headers: { "content-type": "text/event-stream" },
        });
      },
      port: 0,
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  afterEach(() => {
    requests = [];
  });

  test("sends the workspace key in x-api-key and returns the reply", async () => {
    const models = createCloudModels(workspaceKeyStore(async () => KEY));
    const model = models.getModel("anthropic", "claude-sonnet-5-5");
    expect(model).toBeDefined();
    if (!model) {
      return;
    }

    const result = await models.complete(
      { ...model, baseUrl: server.url.origin },
      context
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/v1/messages");
    expect(requests[0]?.apiKey).toBe(KEY);
    const text = result.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    expect(text).toContain("pelican");
  });

  test("with no workspace key, the ambient ANTHROPIC_API_KEY is not used", async () => {
    const savedEnvKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = ENV_KEY;

    let message = "";
    try {
      const models = createCloudModels(workspaceKeyStore(async () => null));
      const model = models.getModel("anthropic", "claude-sonnet-5-5");
      expect(model).toBeDefined();
      if (!model) {
        return;
      }
      const result: AssistantMessage = await models.complete(
        { ...model, baseUrl: server.url.origin },
        context
      );
      message = result.errorMessage ?? "";
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      if (savedEnvKey === undefined) {
        Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
      } else {
        process.env.ANTHROPIC_API_KEY = savedEnvKey;
      }
    }

    expect(message).toContain(NO_KEY_MESSAGE);
    expect(requests).toHaveLength(0);
  });
});
