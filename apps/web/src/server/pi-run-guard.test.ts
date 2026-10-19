import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { GenerationTask } from "@earendil-works/pi-durable";
import { REPEAT_WARN_AT, repeatWarning } from "@repo/protocol/safeguards";
import { repeatGuardExtension, warnRepeats } from "./pi-run-guard.ts";

const TOOL = "bash";
const ARGS = { command: "ls /missing" };
const warning = repeatWarning(TOOL, REPEAT_WARN_AT);

const zeroUsage = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
};

const assistantCall = (
  id: string,
  name: string,
  args: Record<string, string>
): AssistantMessage => ({
  api: "anthropic-messages",
  content: [{ arguments: args, id, name, type: "toolCall" }],
  model: "test-model",
  provider: "anthropic",
  role: "assistant",
  stopReason: "toolUse",
  timestamp: 0,
  usage: zeroUsage,
});

const toolResult = (
  id: string,
  name: string,
  isError: boolean,
  text = isError ? "exit 2" : "ok"
): ToolResultMessage => ({
  content: [{ text, type: "text" }],
  isError,
  role: "toolResult",
  timestamp: 0,
  toolCallId: id,
  toolName: name,
});

const userMessage = (text: string): UserMessage => ({
  content: text,
  role: "user",
  timestamp: 0,
});

/** One call and its result, with its own id. */
const exchange = (
  n: number,
  name: string,
  args: Record<string, string>,
  isError: boolean
): Message[] => {
  const id = `call-${n}`;
  return [assistantCall(id, name, args), toolResult(id, name, isError)];
};

/** `count` calls in a row to one tool with the same arguments, all failing. */
const failures = (
  count: number,
  name = TOOL,
  args: Record<string, string> = ARGS
): Message[] =>
  Array.from({ length: count }, (_, index) =>
    exchange(index + 1, name, args, true)
  ).flat();

const warningPartsOf = (message: Message | undefined): number =>
  message?.role === "toolResult"
    ? message.content.filter(
        (part) =>
          part.type === "text" &&
          part.text === repeatWarning(message.toolName, REPEAT_WARN_AT)
      ).length
    : 0;

/** The messages that carry the warning, by index. */
const warnedAt = (messages: readonly Message[]): number[] =>
  messages
    .map((message, index) => (warningPartsOf(message) > 0 ? index : -1))
    .filter((index) => index >= 0);

describe("warnRepeats", () => {
  test("gives no warning for two identical failures", () => {
    const messages = failures(2);
    const out = warnRepeats(messages);

    expect(warnedAt(out)).toEqual([]);
    expect(out).toEqual(messages);
  });

  test("adds the warning after the third identical failed result and keeps what it had", () => {
    const messages = failures(3);
    const out = warnRepeats(messages);
    const third = out.at(5);

    expect(warnedAt(out)).toEqual([5]);
    expect(third).toEqual({
      ...toolResult("call-3", TOOL, true),
      content: [
        { text: "exit 2", type: "text" },
        { text: warning, type: "text" },
      ],
    });
    expect(messages[5]).toMatchObject({
      content: [{ text: "exit 2", type: "text" }],
    });
  });

  test("gives no warning on the fourth and fifth identical failures", () => {
    const messages = failures(5);
    const out = warnRepeats(messages);

    expect(warnedAt(out)).toEqual([5]);
    expect(out[7]).toBe(messages[7]);
    expect(out[9]).toBe(messages[9]);
  });

  test("gives the same warning on every call of the same messages", () => {
    const messages = [...failures(3), userMessage("again?")];

    expect(warnRepeats(messages)).toEqual(warnRepeats(messages));
    expect(warnedAt(warnRepeats(messages))).toEqual([5]);
  });

  test("a different argument starts the count again", () => {
    const messages = [
      ...failures(2),
      ...exchange(3, TOOL, { command: "ls /other" }, true),
      ...exchange(4, TOOL, ARGS, true),
    ];

    expect(warnedAt(warnRepeats(messages))).toEqual([]);
  });

  test("a different tool starts the count again", () => {
    const messages = [
      ...failures(2),
      ...exchange(3, "search", ARGS, true),
      ...exchange(4, TOOL, ARGS, true),
    ];

    expect(warnedAt(warnRepeats(messages))).toEqual([]);
  });

  test("a success in between resets the count", () => {
    const messages = [
      ...failures(2),
      ...exchange(3, TOOL, ARGS, false),
      ...exchange(4, TOOL, ARGS, true),
      ...exchange(5, TOOL, ARGS, true),
    ];

    expect(warnedAt(warnRepeats(messages))).toEqual([]);
  });

  test("counts failures that are invalid-argument errors the same way", () => {
    const invalid = (n: number): Message[] => {
      const id = `bad-${n}`;
      return [
        assistantCall(id, "search", { q: "" }),
        toolResult(id, "search", true, "Validation failed: q is required"),
      ];
    };
    const messages = [...invalid(1), ...invalid(2), ...invalid(3)];

    expect(warnedAt(warnRepeats(messages))).toEqual([5]);
  });

  test("returns the same objects for messages it does not change", () => {
    const user = userMessage("hi");
    const call = assistantCall("c", TOOL, ARGS);
    const messages: Message[] = [user, call, toolResult("c", TOOL, false)];
    const out = warnRepeats(messages);

    expect(out[0]).toBe(user);
    expect(out[1]).toBe(call);
    expect(out[2]).toBe(messages[2]);
  });

  test("a result with no call in the list is left alone and does not count", () => {
    const orphan = toolResult("missing", TOOL, true);
    const messages: Message[] = [
      ...failures(2),
      orphan,
      ...exchange(3, TOOL, ARGS, true),
    ];
    const out = warnRepeats(messages);

    expect(out[4]).toBe(orphan);
    expect(warnedAt(out)).toEqual([6]);
  });
});

describe("repeatGuardExtension", () => {
  test("registers one hook, on the generation task", () => {
    const extension = repeatGuardExtension();

    expect(extension.name).toBe("repeat-guard");
    expect(extension.hooks).toHaveLength(1);
    expect(extension.hooks?.[0]?.task).toBe(GenerationTask.definition.name);
  });

  test("its beforeRequest hook returns the warned messages, and nothing when there is no warning", () => {
    const handlers = repeatGuardExtension().hooks?.[0]?.handlers as {
      beforeRequest: (request: {
        messages: readonly Message[];
      }) => { messages: readonly Message[] } | undefined;
    };
    const warned = handlers.beforeRequest({ messages: failures(3) });
    expect(warnedAt(warned?.messages ?? [])).toEqual([5]);

    expect(handlers.beforeRequest({ messages: failures(2) })).toBeUndefined();
  });
});
