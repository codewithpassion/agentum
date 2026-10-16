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
 * Pins the tool-result shape pi-durable reads. Between 1.1.0 and 1.2.0 it
 * renamed `content` to `output`, and a tool that still returns `content` gets
 * an empty result with no error, so the model sees nothing. The skills tools in
 * `agents@0.28.1` still return `content`. If a version bump changes the shape,
 * these tests fail before the model goes quiet in production.
 */

const PROBE = "probe";
const TEXT = "tool-output-pinned";

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

/** Calls the tool, then repeats whatever text the tool result carried. */
const script = (context: TranscriptContext): AssistantMessage => {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") {
    return fauxAssistantMessage([fauxText(`saw:${textOf(last.content)}`)]);
  }
  return fauxAssistantMessage([fauxToolCall(PROBE, {})], {
    stopReason: "toolUse",
  });
};

/** What the model read back from the tool, through a real harness. */
const modelSawFrom = async (result: unknown): Promise<string> => {
  const faux = fauxProvider();
  faux.setResponses([script, script]);
  const models = createModels();
  models.setProvider(faux.provider);

  const tool = {
    description: "Returns a fixed result.",
    execute: () => Promise.resolve(result),
    name: PROBE,
    parameters: Type.Object({}),
    replay: "safe",
  } as unknown as ToolRegistration;
  const registry = createRegistry();
  registry.install({ name: "probe", tools: [tool] });

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
  const submission = await root.submit(
    { content: "go", type: "input" },
    BACKGROUND_CONTEXT
  );
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  if (settled.status !== "done") {
    throw new Error(`the run did not finish: ${settled.status}`);
  }

  const page = await root.entries(
    { order: "ascending" },
    50,
    undefined,
    BACKGROUND_CONTEXT
  );
  await harness.close(BACKGROUND_CONTEXT);
  const toolResult = page.items
    .map((entry) => entry.model?.[0])
    .find((message) => message?.role === "toolResult");
  return textOf(toolResult?.content);
};

describe("pi-durable tool result shape", () => {
  test("a tool that returns `output` reaches the model", async () => {
    expect(await modelSawFrom({ output: [{ text: TEXT, type: "text" }] })).toBe(
      TEXT
    );
  });

  test("a tool that returns `content` reaches the model as nothing", async () => {
    expect(
      await modelSawFrom({ content: [{ text: TEXT, type: "text" }] })
    ).toBe("");
  });
});
