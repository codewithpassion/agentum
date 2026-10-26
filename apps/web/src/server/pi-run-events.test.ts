import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  Message,
  Usage as PiUsage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import {
  failureOf,
  finalText,
  sliceRun,
  toolOutcomesOf,
  toRunEvents,
  turnsOf,
  usageOf,
  wantsAnotherTurn,
} from "./pi-run-events.ts";

const entry = (id: string, ...model: Message[]): EntryRecord => ({
  conversationId: "conversation" as unknown as EntryRecord["conversationId"],
  id: id as unknown as EntryRecord["id"],
  kind: "turn",
  model,
});

const usage = (
  input: number,
  output: number,
  cost: number,
  cacheRead = 0,
  cacheWrite = 0
): PiUsage => ({
  cacheRead,
  cacheWrite,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: cost },
  input,
  output,
  totalTokens: input + output,
});

const assistant = (
  content: AssistantMessage["content"],
  extra: Partial<AssistantMessage> = {}
): AssistantMessage => ({
  api: "anthropic-messages",
  content,
  model: "test-model",
  provider: "anthropic",
  role: "assistant",
  stopReason: "stop",
  timestamp: 0,
  usage: usage(0, 0, 0),
  ...extra,
});

const toolResult = (
  toolCallId: string,
  content: ToolResultMessage["content"],
  isError = false
): ToolResultMessage => ({
  content,
  isError,
  role: "toolResult",
  timestamp: 0,
  toolCallId,
  toolName: "bash",
});

const user = (text: string): UserMessage => ({
  content: text,
  role: "user",
  timestamp: 0,
});

const runOne = (): EntryRecord[] => [
  entry("u1", user("list files")),
  entry(
    "a1",
    assistant([
      { text: "Listing.", type: "text" },
      {
        arguments: { cmd: "ls" },
        id: "call-1",
        name: "bash",
        type: "toolCall",
      },
    ])
  ),
  entry("t1", toolResult("call-1", [{ text: "a.txt", type: "text" }])),
  entry("a2", assistant([{ text: "Done: a.txt", type: "text" }])),
];

describe("toRunEvents", () => {
  test("translates text, a tool call, a tool result and a final text in order", () => {
    expect(toRunEvents(runOne())).toEqual([
      { payload: { text: "Listing." }, seq: 1, type: "message.assistant" },
      {
        payload: {
          input: { cmd: "ls" },
          name: "bash",
          toolUseId: "call-1",
        },
        seq: 2,
        type: "tool.call",
      },
      {
        payload: { ok: true, output: "a.txt", toolUseId: "call-1" },
        seq: 3,
        type: "tool.result",
      },
      { payload: { text: "Done: a.txt" }, seq: 4, type: "message.assistant" },
    ]);
  });

  test("translating the same slice twice gives equal output", () => {
    const slice = runOne();
    expect(toRunEvents(slice)).toEqual(toRunEvents(slice));
  });

  test("an assistant message with thinking, text and a tool call gives three events in order", () => {
    const events = toRunEvents([
      entry(
        "a1",
        assistant([
          { thinking: "Plan: list files.", type: "thinking" },
          { text: "Listing.", type: "text" },
          {
            arguments: { cmd: "ls" },
            id: "call-1",
            name: "bash",
            type: "toolCall",
          },
        ])
      ),
    ]);
    expect(events).toEqual([
      {
        payload: { text: "Plan: list files." },
        seq: 1,
        type: "message.reasoning",
      },
      { payload: { text: "Listing." }, seq: 2, type: "message.assistant" },
      {
        payload: { input: { cmd: "ls" }, name: "bash", toolUseId: "call-1" },
        seq: 3,
        type: "tool.call",
      },
    ]);
  });

  test("drops empty, redacted and signature-only thinking and empty text parts", () => {
    const events = toRunEvents([
      entry(
        "a1",
        assistant([
          { thinking: "", type: "thinking" },
          { redacted: true, thinking: "opaque", type: "thinking" },
          { thinking: "", thinkingSignature: "sig", type: "thinking" },
          { text: "", type: "text" },
        ])
      ),
    ]);
    expect(events).toEqual([]);
  });

  test("a failed tool result has ok false", () => {
    const events = toRunEvents([
      entry("t1", toolResult("call-2", [{ text: "boom", type: "text" }], true)),
    ]);
    expect(events).toEqual([
      {
        payload: { ok: false, output: "boom", toolUseId: "call-2" },
        seq: 1,
        type: "tool.result",
      },
    ]);
  });

  test("a non-text tool result part becomes [image]", () => {
    const events = toRunEvents([
      entry(
        "t1",
        toolResult("call-3", [
          { text: "chart", type: "text" },
          { data: "AAAA", mimeType: "image/png", type: "image" },
        ])
      ),
    ]);
    expect(events).toEqual([
      {
        payload: { ok: true, output: "chart\n[image]", toolUseId: "call-3" },
        seq: 1,
        type: "tool.result",
      },
    ]);
  });
});

describe("sliceRun", () => {
  const transcript = [
    entry("r1-start", user("first")),
    entry("r1-a", assistant([{ text: "first answer", type: "text" }])),
    entry("r2-start", user("second")),
    entry("r2-a", assistant([{ text: "second answer", type: "text" }])),
  ];

  test("run 2 has none of run 1's events, and its seqs start at 1", () => {
    const run2 = sliceRun(transcript, "r2-start");
    const events = toRunEvents(run2);
    expect(events).toEqual([
      { payload: { text: "second answer" }, seq: 1, type: "message.assistant" },
    ]);
    expect(
      events.some((event) => JSON.stringify(event).includes("first"))
    ).toBe(false);
  });

  test("end is exclusive", () => {
    expect(
      sliceRun(transcript, "r1-start", "r2-start").map((e) => String(e.id))
    ).toEqual(["r1-start", "r1-a"]);
  });

  test("a missing or unknown end runs to the end of the transcript", () => {
    expect(sliceRun(transcript, "r1-start").map((e) => String(e.id))).toEqual([
      "r1-start",
      "r1-a",
      "r2-start",
      "r2-a",
    ]);
    expect(sliceRun(transcript, "r1-start", "nope").length).toBe(4);
  });

  test("an unknown start gives []", () => {
    expect(sliceRun(transcript, "nope")).toEqual([]);
  });

  test("no start gives []", () => {
    expect(sliceRun(transcript, undefined)).toEqual([]);
  });
});

describe("usageOf", () => {
  test("sums over the assistant messages", () => {
    const slice = [
      entry(
        "a1",
        assistant([{ text: "x", type: "text" }], { usage: usage(10, 5, 0.25) })
      ),
      entry("u1", user("again")),
      entry(
        "a2",
        assistant([{ text: "y", type: "text" }], { usage: usage(7, 3, 0.5) })
      ),
    ];
    expect(usageOf(slice)).toEqual({
      costUsd: 0.75,
      inputTokens: 17,
      model: "test-model",
      outputTokens: 8,
      provider: "anthropic",
    });
  });

  test("names the provider and model of the last assistant message", () => {
    const slice = [
      entry(
        "a1",
        assistant([{ text: "x", type: "text" }], {
          model: "anthropic/claude-x",
          provider: "anthropic",
          usage: usage(10, 5, 0.25),
        })
      ),
      entry(
        "a2",
        assistant([{ text: "y", type: "text" }], {
          model: "z-ai/glm-5.3",
          provider: "openrouter",
          usage: usage(7, 3, 0.5),
        })
      ),
    ];
    expect(usageOf(slice)).toEqual({
      costUsd: 0.75,
      inputTokens: 17,
      model: "z-ai/glm-5.3",
      outputTokens: 8,
      provider: "openrouter",
    });
  });

  test("leaves out an empty provider or model", () => {
    const slice = [
      entry(
        "a1",
        assistant([{ text: "x", type: "text" }], {
          model: "",
          provider: "openrouter",
          usage: usage(1, 1, 0),
        })
      ),
    ];
    expect(usageOf(slice)).toEqual({
      costUsd: 0,
      inputTokens: 1,
      outputTokens: 1,
      provider: "openrouter",
    });
  });

  test("adds cache tokens only when they are above 0", () => {
    const slice = [
      entry(
        "a1",
        assistant([{ text: "x", type: "text" }], {
          usage: usage(1, 1, 0, 4, 2),
        })
      ),
    ];
    expect(usageOf(slice)).toEqual({
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      costUsd: 0,
      inputTokens: 1,
      model: "test-model",
      outputTokens: 1,
      provider: "anthropic",
    });
  });

  test("undefined when there is no assistant message", () => {
    expect(usageOf([entry("u1", user("hi"))])).toBeUndefined();
  });
});

describe("failureOf", () => {
  test("returns the errorMessage of an error-stop message", () => {
    const slice = [
      entry(
        "a1",
        assistant([], { errorMessage: "rate limited", stopReason: "error" })
      ),
    ];
    expect(failureOf(slice)).toBe("rate limited");
  });

  test("undefined when no message stopped with an error", () => {
    const slice = [entry("a1", assistant([{ text: "ok", type: "text" }]))];
    expect(failureOf(slice)).toBeUndefined();
  });
});

describe("finalText", () => {
  test("takes the last assistant text and ignores tool-call-only messages", () => {
    const slice = [
      entry("a1", assistant([{ text: "Working.", type: "text" }])),
      entry(
        "a2",
        assistant([
          {
            arguments: {},
            id: "call-9",
            name: "bash",
            type: "toolCall",
          },
        ])
      ),
      entry("t1", toolResult("call-9", [{ text: "ok", type: "text" }])),
    ];
    expect(finalText(slice)).toBe("Working.");
  });

  test("joins the text parts of the last message that has text", () => {
    const slice = [
      entry(
        "a1",
        assistant([
          { text: "Part one.", type: "text" },
          { text: "Part two.", type: "text" },
        ])
      ),
    ];
    expect(finalText(slice)).toBe("Part one.\nPart two.");
  });

  test("empty string when there is no assistant text", () => {
    expect(finalText([entry("u1", user("hi"))])).toBe("");
  });
});

describe("turnsOf", () => {
  test("0 with no assistant message", () => {
    expect(turnsOf([entry("u1", user("hi"))])).toBe(0);
  });

  test("1 for one assistant message", () => {
    expect(
      turnsOf([entry("a1", assistant([{ text: "x", type: "text" }]))])
    ).toBe(1);
  });

  test("3 for three assistant messages, with tool results between them", () => {
    const slice = [
      entry(
        "a1",
        assistant([{ arguments: {}, id: "c1", name: "bash", type: "toolCall" }])
      ),
      entry("t1", toolResult("c1", [{ text: "ok", type: "text" }])),
      entry(
        "a2",
        assistant([{ arguments: {}, id: "c2", name: "bash", type: "toolCall" }])
      ),
      entry("t2", toolResult("c2", [{ text: "ok", type: "text" }])),
      entry("a3", assistant([{ text: "Done", type: "text" }])),
    ];
    expect(turnsOf(slice)).toBe(3);
  });
});

describe("wantsAnotherTurn", () => {
  test("true when the last assistant message has a tool call", () => {
    const slice = [
      entry(
        "a1",
        assistant([
          { text: "Looking.", type: "text" },
          { arguments: {}, id: "c1", name: "bash", type: "toolCall" },
        ])
      ),
    ];
    expect(wantsAnotherTurn(slice)).toBe(true);
  });

  test("false when the last assistant message is text only", () => {
    const slice = [
      entry(
        "a1",
        assistant([{ arguments: {}, id: "c1", name: "bash", type: "toolCall" }])
      ),
      entry("t1", toolResult("c1", [{ text: "ok", type: "text" }])),
      entry("a2", assistant([{ text: "Done", type: "text" }])),
    ];
    expect(wantsAnotherTurn(slice)).toBe(false);
  });

  test("false for an empty slice", () => {
    expect(wantsAnotherTurn([])).toBe(false);
  });

  test("looks only at the last assistant message", () => {
    const slice = [
      entry("a1", assistant([{ text: "Done", type: "text" }])),
      entry("u1", user("more")),
      entry("a2", assistant([{ text: "Also done", type: "text" }])),
      entry(
        "a3",
        assistant([{ arguments: {}, id: "c1", name: "bash", type: "toolCall" }])
      ),
    ];
    expect(wantsAnotherTurn(slice)).toBe(true);
    expect(wantsAnotherTurn(slice.slice(0, 3))).toBe(false);
  });
});

describe("toolOutcomesOf", () => {
  test("pairs each result with its call, in order, with ok from isError", () => {
    const slice = [
      entry(
        "a1",
        assistant([
          {
            arguments: { cmd: "ls" },
            id: "c1",
            name: "bash",
            type: "toolCall",
          },
        ])
      ),
      entry("t1", toolResult("c1", [{ text: "a.txt", type: "text" }])),
      entry(
        "a2",
        assistant([
          {
            arguments: { path: "x" },
            id: "c2",
            name: "read",
            type: "toolCall",
          },
        ])
      ),
      entry(
        "t2",
        toolResult("c2", [{ text: "no such file", type: "text" }], true)
      ),
    ];
    expect(toolOutcomesOf(slice)).toEqual([
      { input: { cmd: "ls" }, name: "bash", ok: true },
      { input: { path: "x" }, name: "read", ok: false },
    ]);
  });

  test("handles two tool calls in one assistant message", () => {
    const slice = [
      entry(
        "a1",
        assistant([
          {
            arguments: { cmd: "ls" },
            id: "c1",
            name: "bash",
            type: "toolCall",
          },
          {
            arguments: { path: "y" },
            id: "c2",
            name: "read",
            type: "toolCall",
          },
        ])
      ),
      entry("t1", toolResult("c2", [{ text: "y", type: "text" }])),
      entry("t2", toolResult("c1", [{ text: "a.txt", type: "text" }])),
    ];
    expect(toolOutcomesOf(slice)).toEqual([
      { input: { path: "y" }, name: "read", ok: true },
      { input: { cmd: "ls" }, name: "bash", ok: true },
    ]);
  });

  test("drops a result with no matching call", () => {
    const slice = [
      entry("t1", toolResult("orphan", [{ text: "x", type: "text" }])),
      entry(
        "a1",
        assistant([{ arguments: {}, id: "c1", name: "bash", type: "toolCall" }])
      ),
      entry("t2", toolResult("c1", [{ text: "ok", type: "text" }])),
    ];
    expect(toolOutcomesOf(slice)).toEqual([
      { input: {}, name: "bash", ok: true },
    ]);
  });
});
