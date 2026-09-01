import { describe, expect, test } from "bun:test";
import type {
  ChatCompletion,
  ChatMessage,
  ChatModel,
  ChatRequest,
} from "./chat";
import {
  type RunStore,
  type StepDeps,
  step,
  TOOL_RESULT_MAX_BYTES,
} from "./step";
import type { ToolResult, ToolRunner } from "./tools";

/**
 * The loop as a state machine over the transcript. Each test seeds a
 * transcript, runs steps, and reads the transcript back - which is exactly
 * what a Durable Object that died and resumed would do.
 */

const memoryStore = (initial: ChatMessage[] = []) => {
  const messages = [...initial];
  let partial: Record<string, ToolResult> = {};
  let pending: string[] = [];
  let cancelled = false;
  const store: RunStore = {
    appendMessage: (message) => {
      messages.push(message);
      return Promise.resolve();
    },
    clearPartialResults: () => {
      partial = {};
      return Promise.resolve();
    },
    isCancelled: () => Promise.resolve(cancelled),
    messages: () => Promise.resolve([...messages]),
    partialResults: () => Promise.resolve({ ...partial }),
    savePartialResult: (id, result) => {
      partial[id] = result;
      return Promise.resolve();
    },
    takePending: () => {
      const taken = pending;
      pending = [];
      return Promise.resolve(taken);
    },
  };
  return {
    cancel: () => {
      cancelled = true;
    },
    messages,
    partial: () => partial,
    send: (text: string) => pending.push(text),
    store,
  };
};

const answer = (text: string): ChatCompletion => ({
  finishReason: "stop",
  text,
  toolCalls: [],
  usage: null,
});

const callTool = (
  name: string,
  args: Record<string, unknown>,
  id = `call_${name}`
): ChatCompletion => ({
  finishReason: "tool_calls",
  text: "",
  toolCalls: [{ arguments: args, id, name }],
  usage: null,
});

/** Answers in order; records every request it saw. */
const scriptedModel = (completions: ChatCompletion[]) => {
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    complete: (request) => {
      requests.push(request);
      const next = completions.shift();
      if (!next) {
        throw new Error("The script ran out of completions.");
      }
      return Promise.resolve(next);
    },
  };
  return { model, requests };
};

const fakeTools = (
  handler: (name: string, args: Record<string, unknown>) => ToolResult
) => {
  const calls: { args: Record<string, unknown>; name: string }[] = [];
  const tools: ToolRunner = {
    call: (name, args) => {
      calls.push({ args, name });
      return Promise.resolve(handler(name, args));
    },
    close: () => Promise.resolve(),
    definitions: () => [
      {
        description: "Post",
        name: "post_message",
        parameters: { type: "object" },
      },
    ],
  };
  return { calls, tools };
};

const depsFor = (
  model: ChatModel,
  tools: ToolRunner,
  emitted: string[] = []
): StepDeps => ({
  emitText: (text) => {
    emitted.push(text);
    return Promise.resolve();
  },
  maxTokens: 100,
  model,
  modelId: "@cf/test",
  system: "You are Researcher.",
  tools,
});

/** Runs steps until the loop reports anything but "continue". */
const drain = async (store: RunStore, deps: StepDeps, limit = 20) => {
  for (let i = 0; i < limit; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: steps are sequential by nature
    const outcome = await step(store, deps);
    if (outcome.kind !== "continue") {
      return outcome;
    }
  }
  throw new Error("The loop did not settle.");
};

describe("step", () => {
  test("asks the model, runs its tool call, and goes idle on the answer", async () => {
    const run = memoryStore([{ content: "@Researcher hi", role: "user" }]);
    const { model, requests } = scriptedModel([
      callTool("post_message", { body: "hello", channelId: "c1" }),
      answer("Posted."),
    ]);
    const { calls, tools } = fakeTools(() => ({
      isError: false,
      text: '{"messageId":"m1"}',
    }));
    const emitted: string[] = [];

    const outcome = await drain(run.store, depsFor(model, tools, emitted));

    expect(outcome).toEqual({ kind: "idle" });
    expect(calls).toEqual([
      { args: { body: "hello", channelId: "c1" }, name: "post_message" },
    ]);
    expect(run.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(run.messages[2]).toEqual({
      content: '{"messageId":"m1"}',
      name: "post_message",
      role: "tool",
      toolCallId: "call_post_message",
    });
    // The second request carried the whole transcript, system prompt and tools.
    expect(requests[1]?.messages).toHaveLength(3);
    expect(requests[1]?.system).toBe("You are Researcher.");
    expect(requests[1]?.tools.map((tool) => tool.name)).toEqual([
      "post_message",
    ]);
    expect(emitted).toEqual(["Posted."]);
  });

  test("reports which steps called the model", async () => {
    const run = memoryStore([{ content: "hi", role: "user" }]);
    const { model } = scriptedModel([
      callTool("post_message", {}),
      answer("ok"),
    ]);
    const { tools } = fakeTools(() => ({ isError: false, text: "{}" }));
    const deps = depsFor(model, tools);

    expect(await step(run.store, deps)).toEqual({
      calledModel: true,
      kind: "continue",
    });
    expect(await step(run.store, deps)).toEqual({
      calledModel: false,
      kind: "continue",
    });
    expect(await step(run.store, deps)).toEqual({
      calledModel: true,
      kind: "continue",
    });
    expect(await step(run.store, deps)).toEqual({ kind: "idle" });
  });

  test("a tool error reaches the model as an error result, not a crash", async () => {
    const run = memoryStore([{ content: "hi", role: "user" }]);
    const { model } = scriptedModel([
      callTool("post_message", { channelId: "nope" }),
      answer("Sorry, I cannot post there."),
    ]);
    const { tools } = fakeTools(() => ({
      isError: true,
      text: "You are not a member of that channel.",
    }));

    await drain(run.store, depsFor(model, tools));

    expect(run.messages[2]?.content).toBe(
      "Error: You are not a member of that channel."
    );
  });

  test("a tool that throws is reported the same way", async () => {
    const run = memoryStore([{ content: "hi", role: "user" }]);
    const { model } = scriptedModel([
      callTool("post_message", {}),
      answer("ok"),
    ]);
    const tools: ToolRunner = {
      call: () => Promise.reject(new Error("boom")),
      close: () => Promise.resolve(),
      definitions: () => [],
    };

    await drain(run.store, depsFor(model, tools));

    expect(run.messages[2]?.content).toBe("Error: boom");
  });

  test("caps a tool result that would swamp the transcript", async () => {
    const run = memoryStore([{ content: "hi", role: "user" }]);
    const { model } = scriptedModel([
      callTool("post_message", {}),
      answer("ok"),
    ]);
    const { tools } = fakeTools(() => ({
      isError: false,
      text: "x".repeat(TOOL_RESULT_MAX_BYTES * 2),
    }));

    await drain(run.store, depsFor(model, tools));

    const content = run.messages[2]?.content ?? "";
    expect(content.length).toBeLessThan(TOOL_RESULT_MAX_BYTES + 200);
    expect(content).toContain("[truncated: showing the first");
  });

  test("resumes a tool turn without re-running the calls it already made", async () => {
    // The host died after the first of two calls had run.
    const run = memoryStore([
      { content: "hi", role: "user" },
      {
        content: "",
        role: "assistant",
        toolCalls: [
          { arguments: { n: 1 }, id: "call_a", name: "post_message" },
          { arguments: { n: 2 }, id: "call_b", name: "post_message" },
        ],
      },
    ]);
    await run.store.savePartialResult("call_a", {
      isError: false,
      text: "first",
    });
    const { calls, tools } = fakeTools(() => ({
      isError: false,
      text: "second",
    }));
    const { model } = scriptedModel([answer("done")]);

    await drain(run.store, depsFor(model, tools));

    expect(calls).toEqual([{ args: { n: 2 }, name: "post_message" }]);
    expect(run.messages.slice(2, 4)).toEqual([
      {
        content: "first",
        name: "post_message",
        role: "tool",
        toolCallId: "call_a",
      },
      {
        content: "second",
        name: "post_message",
        role: "tool",
        toolCallId: "call_b",
      },
    ]);
    expect(run.partial()).toEqual({});
  });

  test("text sent in while the run is busy becomes the next user turn", async () => {
    const run = memoryStore([{ content: "hi", role: "user" }]);
    const { model, requests } = scriptedModel([
      callTool("post_message", {}),
      answer("done with both"),
    ]);
    const { tools } = fakeTools(() => {
      run.send("also, one more thing");
      return { isError: false, text: "{}" };
    });

    await drain(run.store, depsFor(model, tools));

    // Tool results first, then what arrived meanwhile, as a user message.
    expect(run.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
      "assistant",
    ]);
    expect(run.messages[3]?.content).toBe("also, one more thing");
    expect(requests[1]?.messages.at(-1)?.content).toBe("also, one more thing");
  });

  test("text sent in after the turn ended starts a new one instead of idling", async () => {
    const run = memoryStore([
      { content: "hi", role: "user" },
      { content: "Hello!", role: "assistant", toolCalls: [] },
    ]);
    run.send("and now?");
    const { model } = scriptedModel([answer("Now this.")]);
    const { tools } = fakeTools(() => ({ isError: false, text: "" }));

    const outcome = await drain(run.store, depsFor(model, tools));

    expect(outcome).toEqual({ kind: "idle" });
    expect(run.messages.slice(2)).toEqual([
      { content: "and now?", role: "user" },
      { content: "Now this.", role: "assistant", toolCalls: [] },
    ]);
  });

  test("a cancelled run stops before touching the model", async () => {
    const run = memoryStore([{ content: "hi", role: "user" }]);
    run.cancel();
    const { model, requests } = scriptedModel([answer("never")]);
    const { tools } = fakeTools(() => ({ isError: false, text: "" }));

    expect(await step(run.store, depsFor(model, tools))).toEqual({
      kind: "cancelled",
    });
    expect(requests).toEqual([]);
  });

  test("an empty transcript is simply idle", async () => {
    const run = memoryStore();
    const { model } = scriptedModel([]);
    const { tools } = fakeTools(() => ({ isError: false, text: "" }));

    expect(await step(run.store, depsFor(model, tools))).toEqual({
      kind: "idle",
    });
  });
});
