import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  Context,
  CredentialStore,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { serve } from "bun";
import { createCloudModels } from "./pi-run-models.ts";

const OPENROUTER_KEY = "sk-or-test-key";
const ANTHROPIC_KEY = "sk-ant-test";

const store: CredentialStore = {
  delete: () => Promise.reject(new Error("read-only test store")),
  list: () => Promise.resolve([]),
  modify: () => Promise.reject(new Error("read-only test store")),
  read: (providerId) => {
    if (providerId === "openrouter") {
      return Promise.resolve({ key: OPENROUTER_KEY, type: "api_key" });
    }
    if (providerId === "anthropic") {
      return Promise.resolve({ key: ANTHROPIC_KEY, type: "api_key" });
    }
    return Promise.resolve(undefined);
  },
};

const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const chatChunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

const CHAT_STREAM = [
  chatChunk({
    choices: [
      {
        delta: { content: "pelican", role: "assistant" },
        finish_reason: null,
        index: 0,
      },
    ],
    created: 1,
    id: "chatcmpl-test",
    model: "z-ai/glm-5.3",
    object: "chat.completion.chunk",
  }),
  chatChunk({
    choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
    created: 1,
    id: "chatcmpl-test",
    model: "z-ai/glm-5.3",
    object: "chat.completion.chunk",
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
  }),
  "data: [DONE]\n\n",
].join("");

const ANTHROPIC_STREAM = [
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Reads one field of a parsed JSON body. */
const field = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

const textOf = (content: AssistantMessage["content"]): string =>
  content.map((block) => (block.type === "text" ? block.text : "")).join("");

interface Received {
  authorization: string | null;
  body: unknown;
  path: string;
  sessionId: string | null;
}

describe("cloud models", () => {
  let server: ReturnType<typeof serve>;
  let received: Received[] = [];

  beforeAll(() => {
    server = serve({
      async fetch(request) {
        const url = new URL(request.url);
        received.push({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
          path: url.pathname,
          sessionId: request.headers.get("x-session-id"),
        });
        if (url.pathname === "/v1/messages") {
          return new Response(ANTHROPIC_STREAM, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(CHAT_STREAM, {
          headers: { "content-type": "text/event-stream" },
        });
      },
      port: 0,
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  test.each([
    "z-ai/glm-5.3",
    "z-ai/glm-5.3-flash",
    "deepseek/deepseek-v4.1-flash",
  ])("the bundled OpenRouter catalog has %s", (id) => {
    const models = createCloudModels(store);
    expect(models.getModel("openrouter", id)).toBeDefined();
  });

  test("a direct OpenRouter call carries the routing, the bearer key and the session id", async () => {
    received = [];
    const models = createCloudModels(store);
    const model = models.getModel("openrouter", "z-ai/glm-5.3");
    expect(model).toBeDefined();
    if (!model) {
      return;
    }

    const result = await models.complete(
      { ...model, baseUrl: server.url.origin },
      context,
      { sessionId: "sess-1" }
    );

    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request?.path).toBe("/chat/completions");
    expect(request?.authorization).toBe(`Bearer ${OPENROUTER_KEY}`);
    expect(request?.sessionId).toBe("sess-1");
    expect(field(request?.body, "model")).toBe("z-ai/glm-5.3");

    const provider = field(request?.body, "provider");
    const quantizations = field(provider, "quantizations");
    expect(quantizations).toEqual(expect.arrayContaining(["fp8"]));
    expect(quantizations).toEqual(expect.not.arrayContaining(["fp4"]));
    expect(field(provider, "require_parameters")).toBe(true);
    expect(provider).not.toHaveProperty("order");
    expect(provider).not.toHaveProperty("only");

    expect(textOf(result.content)).toContain("pelican");
  });

  test("the Pi harness sends a stable session id and the routing on each submission", async () => {
    received = [];
    const models = createCloudModels(store);
    const real = models.getProvider("openrouter");
    expect(real).toBeDefined();
    if (!real) {
      return;
    }
    const { origin } = server.url;
    models.setProvider({
      ...real,
      stream: (model, ctx, options) =>
        real.stream({ ...model, baseUrl: origin }, ctx, options),
      streamSimple: (model, ctx, options) =>
        real.streamSimple({ ...model, baseUrl: origin }, ctx, options),
    });

    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry: createRegistry() },
      BACKGROUND_CONTEXT
    );
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { modelId: "z-ai/glm-5.3", provider: "openrouter" },
      },
    });
    const send = async () => {
      const submission = await root.submit(
        { content: "Reply with the word pelican", type: "input" },
        BACKGROUND_CONTEXT
      );
      await submission.wait(BACKGROUND_CONTEXT);
    };
    await send();
    await send();
    await harness.close(BACKGROUND_CONTEXT);

    expect(received).toHaveLength(2);
    const [first, second] = received;
    expect(first?.path).toBe("/chat/completions");
    expect(typeof first?.sessionId).toBe("string");
    expect(first?.sessionId).not.toBe("");
    expect(second?.sessionId).toBe(first?.sessionId);
    for (const request of received) {
      expect(request.authorization).toBe(`Bearer ${OPENROUTER_KEY}`);
      const provider = field(request.body, "provider");
      const quantizations = field(provider, "quantizations");
      expect(quantizations).toEqual(expect.arrayContaining(["fp8"]));
      expect(quantizations).toEqual(expect.not.arrayContaining(["fp4"]));
      expect(field(provider, "require_parameters")).toBe(true);
      expect(provider).not.toHaveProperty("order");
    }
  });

  test("an Anthropic request carries no provider routing", async () => {
    received = [];
    const models = createCloudModels(store);
    const model = models.getModel("anthropic", "claude-sonnet-5-5");
    expect(model).toBeDefined();
    if (!model) {
      return;
    }

    await models.complete({ ...model, baseUrl: server.url.origin }, context);

    const [request] = received;
    expect(received).toHaveLength(1);
    expect(request?.path).toBe("/v1/messages");
    expect(request?.body).not.toHaveProperty("provider");
    expect(JSON.stringify(request?.body)).not.toContain("require_parameters");
  });
});
