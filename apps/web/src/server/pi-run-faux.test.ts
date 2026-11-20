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

const fromPeer = (text: string): string =>
  JSON.stringify({
    harbourmaster_turn: { from: { kind: "peer" }, text, via: "a2a" },
  });

describe("fauxScript", () => {
  test("say <text> answers with exactly the text", () => {
    const reply = fauxScript(contextEndingWith(userPrompt("say Hello there")));

    expect(reply.stopReason).toBe("stop");
    expect(reply.content).toEqual([{ text: "Hello there", type: "text" }]);
  });

  test("the commands read the text inside a peer envelope", () => {
    const asked = fauxScript(
      contextEndingWith(userPrompt(fromPeer("ask Which colour?")))
    );
    expect(toolCallsOf(asked)[0]?.name).toBe("ask_user");

    const said = fauxScript(
      contextEndingWith(userPrompt(fromPeer("say Done")))
    );
    expect(said.content).toEqual([{ text: "Done", type: "text" }]);
  });

  test("any other envelope text is echoed whole, as before", () => {
    const envelope = fromPeer("hello");
    const reply = fauxScript(contextEndingWith(userPrompt(envelope)));

    expect(reply.content).toEqual([
      { text: `echo: ${envelope}`, type: "text" },
    ]);
  });

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

  // Pi appends a system message after the user's message when a prompt section
  // changes, and a cloud run's task folder differs per run, so the second
  // message of a conversation ends with one.
  const sectionUpdate: Message = {
    content: "",
    role: "system",
    sections: { "library-files": "<library-files>new task</library-files>" },
    timestamp: 0,
  };

  test("a system update after the user's message does not hide the prompt", () => {
    const reply = fauxScript(
      normalizeContext({
        messages: [
          userPrompt("hello"),
          fauxAssistantMessage([fauxText("echo: hello")]),
          userPrompt("second message"),
          sectionUpdate,
        ],
      })
    );

    expect(reply.content).toEqual([
      { text: "echo: second message", type: "text" },
    ]);
  });

  test("a system update after a tool result does not hide the result", () => {
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
          sectionUpdate,
        ],
      })
    );

    expect(reply.content).toEqual([
      { text: "tool said: gated ran 1 times", type: "text" },
    ]);
  });
});
