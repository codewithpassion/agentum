import { describe, expect, test } from "bun:test";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxText,
  type Message,
  normalizeContext,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { fauxScript } from "./pi-run-faux.ts";

const userPrompt = (text: string): Message => ({
  content: text,
  role: "user",
  timestamp: 0,
});

const contextEndingWith = (message: Message): TranscriptContext =>
  normalizeContext({ messages: [message] });

const toolCallsOf = (message: AssistantMessage) =>
  message.content.filter((part) => part.type === "toolCall");

describe("fauxScript", () => {
  test("ask <question> calls ask_user with the question", () => {
    const reply = fauxScript(
      contextEndingWith(userPrompt("ask Which colour?"))
    );

    expect(reply.stopReason).toBe("toolUse");
    expect(toolCallsOf(reply)).toEqual([
      {
        arguments: { question: "Which colour?" },
        id: expect.any(String),
        name: "ask_user",
        type: "toolCall",
      },
    ]);
  });

  test("gated calls dev_gated with no arguments", () => {
    const reply = fauxScript(contextEndingWith(userPrompt("gated")));

    expect(reply.stopReason).toBe("toolUse");
    expect(toolCallsOf(reply)).toEqual([
      {
        arguments: {},
        id: expect.any(String),
        name: "dev_gated",
        type: "toolCall",
      },
    ]);
  });

  test("a tool result as the last message is repeated back", () => {
    const reply = fauxScript(
      normalizeContext({
        messages: [
          userPrompt("gated"),
          fauxAssistantMessage([fauxText("calling")]),
          {
            content: [{ text: "gated ran 1 times", type: "text" }],
            isError: false,
            role: "toolResult",
            timestamp: 0,
            toolCallId: "call-1",
            toolName: "dev_gated",
          },
        ],
      })
    );

    expect(reply.content).toEqual([
      { text: "tool said: gated ran 1 times", type: "text" },
    ]);
  });
});
