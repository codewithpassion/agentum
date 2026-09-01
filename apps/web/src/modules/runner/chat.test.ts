import { describe, expect, test } from "bun:test";
import { type ChatRequest, parseCompletion, toWireRequest } from "./chat";

/**
 * The runner speaks one dialect out and reads three in. What matters is that
 * every dialect a model behind the `AI` binding may answer in lands on the
 * same completion, with the same call ids the transcript pairs results to.
 */

describe("toWireRequest", () => {
  const request: ChatRequest = {
    maxTokens: 100,
    messages: [
      { content: "hello", role: "user" },
      {
        content: "",
        role: "assistant",
        toolCalls: [
          {
            arguments: { channelId: "c1" },
            id: "call_1",
            name: "read_channel",
          },
        ],
      },
      {
        content: "{}",
        name: "read_channel",
        role: "tool",
        toolCallId: "call_1",
      },
    ],
    model: "@cf/test",
    system: "Be brief.",
    tools: [
      {
        description: "Read",
        name: "read_channel",
        parameters: { properties: {}, type: "object" },
      },
    ],
  };

  test("puts the system prompt first and tool calls in chat-completions form", () => {
    const wire = toWireRequest(request);

    expect(wire.max_tokens).toBe(100);
    expect(wire.messages[0]).toEqual({ content: "Be brief.", role: "system" });
    expect(wire.messages[2]).toEqual({
      content: "",
      role: "assistant",
      tool_calls: [
        {
          function: { arguments: '{"channelId":"c1"}', name: "read_channel" },
          id: "call_1",
          type: "function",
        },
      ],
    });
    expect(wire.messages[3]).toEqual({
      content: "{}",
      name: "read_channel",
      role: "tool",
      tool_call_id: "call_1",
    });
    expect(wire.tools).toEqual([
      {
        function: {
          description: "Read",
          name: "read_channel",
          parameters: { properties: {}, type: "object" },
        },
        type: "function",
      },
    ]);
  });

  test("omits tools and tool_calls when there are none", () => {
    const wire = toWireRequest({
      ...request,
      messages: [
        { content: "hi", role: "user" },
        { content: "hello", role: "assistant", toolCalls: [] },
      ],
      tools: [],
    });

    expect(wire.tools).toBeUndefined();
    expect(wire.messages[2]).toEqual({ content: "hello", role: "assistant" });
  });
});

describe("parseCompletion", () => {
  test("reads the chat-completions shape, parsing JSON arguments", () => {
    const completion = parseCompletion({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            role: "assistant",
            tool_calls: [
              {
                function: {
                  arguments: '{"channelId":"c1","body":"hi"}',
                  name: "post_message",
                },
                id: "call_abc",
                type: "function",
              },
            ],
          },
        },
      ],
      usage: { completion_tokens: 7, prompt_tokens: 42 },
    });

    expect(completion).toEqual({
      finishReason: "tool_calls",
      text: "",
      toolCalls: [
        {
          arguments: { body: "hi", channelId: "c1" },
          id: "call_abc",
          name: "post_message",
        },
      ],
      usage: { inputTokens: 42, outputTokens: 7 },
    });
  });

  test("reads a plain chat-completions answer", () => {
    const completion = parseCompletion({
      choices: [{ finish_reason: "stop", message: { content: "Done." } }],
    });

    expect(completion.text).toBe("Done.");
    expect(completion.finishReason).toBe("stop");
    expect(completion.toolCalls).toEqual([]);
    expect(completion.usage).toBeNull();
  });

  test("reads the older Workers AI shape and mints call ids", () => {
    const completion = parseCompletion({
      response: "",
      tool_calls: [
        { arguments: { slug: "ops" }, name: "wiki_read" },
        { arguments: { query: "deploy" }, name: "wiki_search" },
      ],
      usage: { completion_tokens: 3, prompt_tokens: 9, total_tokens: 12 },
    });

    expect(completion.finishReason).toBe("tool_calls");
    expect(completion.toolCalls).toEqual([
      { arguments: { slug: "ops" }, id: "call_0", name: "wiki_read" },
      { arguments: { query: "deploy" }, id: "call_1", name: "wiki_search" },
    ]);
    expect(completion.usage).toEqual({ inputTokens: 9, outputTokens: 3 });
  });

  test("reads Anthropic content blocks", () => {
    const completion = parseCompletion({
      content: [
        { text: "Looking that up.", type: "text" },
        {
          id: "toolu_1",
          input: { slug: "ops" },
          name: "wiki_read",
          type: "tool_use",
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 5, output_tokens: 6 },
    });

    expect(completion.text).toBe("Looking that up.");
    expect(completion.toolCalls).toEqual([
      { arguments: { slug: "ops" }, id: "toolu_1", name: "wiki_read" },
    ]);
    expect(completion.finishReason).toBe("tool_calls");
    expect(completion.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  });

  test("a bare string is a finished answer", () => {
    expect(parseCompletion("Hello")).toEqual({
      finishReason: "stop",
      text: "Hello",
      toolCalls: [],
      usage: null,
    });
  });

  test("unparseable arguments become an empty object rather than a crash", () => {
    const completion = parseCompletion({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: { arguments: "{not json", name: "wiki_list" },
                id: "c",
              },
            ],
          },
        },
      ],
    });

    expect(completion.toolCalls[0]?.arguments).toEqual({});
  });

  test("maps a cut-off answer to length", () => {
    expect(
      parseCompletion({
        choices: [{ finish_reason: "length", message: { content: "and" } }],
      }).finishReason
    ).toBe("length");
    expect(
      parseCompletion({ content: [], stop_reason: "max_tokens" }).finishReason
    ).toBe("length");
  });

  test("refuses a payload in no known dialect", () => {
    expect(() => parseCompletion({ result: "?" })).toThrow(
      "unrecognised response"
    );
    expect(() => parseCompletion(null)).toThrow("unrecognised response");
  });
});
