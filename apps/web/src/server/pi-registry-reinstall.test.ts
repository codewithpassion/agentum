import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
  type TranscriptContext,
  Type,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";

/**
 * Pins what C.5 relies on. A conversation does not fix its tools when it is
 * created: an extension installed or removed in the registry is seen by the
 * next submission of the same conversation, and a tool that is gone answers
 * "not available". So the MCP bridge only has to re-install a changed tool
 * list, and needs no new session. If a pi-durable bump changes this, these
 * tests fail before a cloud run keeps calling tools that no longer exist.
 */

const RESPONSES = 20;

const textOf = (content: Message["content"] | undefined): string => {
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) =>
      "text" in part && typeof part.text === "string" ? part.text : ""
    )
    .join("");
};

/** Calls the tool named by the prompt, then repeats what the tool result said. */
const script = (context: TranscriptContext): AssistantMessage => {
  if (context.messages.at(-1)?.role === "toolResult") {
    const last = context.messages.at(-1);
    return fauxAssistantMessage([fauxText(textOf(last?.content))]);
  }
  const prompt = [...context.messages]
    .reverse()
    .find((message) => message.role === "user");
  return fauxAssistantMessage([fauxToolCall(textOf(prompt?.content), {})], {
    stopReason: "toolUse",
  });
};

const probe = (name: string): ToolRegistration =>
  ({
    description: name,
    execute: () =>
      Promise.resolve({ output: [{ text: `${name} ran`, type: "text" }] }),
    name,
    parameters: Type.Object({}),
    replay: "safe",
  }) as unknown as ToolRegistration;

/** A conversation whose registry the test changes between submissions. */
const open = async () => {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: RESPONSES }, () => script));
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry },
    BACKGROUND_CONTEXT
  );
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: { modelId: faux.getModel().id, provider: faux.provider.id },
    },
  });
  /** What the model read back from the tool it called. */
  const call = async (name: string): Promise<string> => {
    const submission = await root.submit(
      { content: name, type: "input" },
      BACKGROUND_CONTEXT
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const page = await root.entries(
      { order: "ascending" },
      100,
      undefined,
      BACKGROUND_CONTEXT
    );
    const results = page.items
      .map((entry) => entry.model?.[0])
      .filter((message) => message?.role === "toolResult");
    return textOf(results.at(-1)?.content);
  };
  return { call, close: () => harness.close(BACKGROUND_CONTEXT), registry };
};

describe("pi-durable registry changes", () => {
  test("a tool installed after the conversation exists is callable on the next submission", async () => {
    const { call, close, registry } = await open();
    registry.install({ name: "mcp-a", tools: [probe("a_one")] });
    expect(await call("a_one")).toBe("a_one ran");

    registry.install({
      name: "mcp-a",
      tools: [probe("a_one"), probe("a_two")],
    });
    expect(await call("a_two")).toBe("a_two ran");
    await close();
  });

  test("a tool that was uninstalled is not available on the next submission", async () => {
    const { call, close, registry } = await open();
    registry.install({ name: "mcp-a", tools: [probe("a_one")] });
    expect(await call("a_one")).toBe("a_one ran");

    registry.uninstall({ name: "mcp-a" });
    expect(await call("a_one")).toContain("Tool a_one is not available");
    await close();
  });
});
