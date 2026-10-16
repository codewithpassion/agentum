// Tests for normalize.ts, using hand-written SDK message objects.
import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { normalizeMessage, sessionIdOf, summariseResult } from "./normalize.ts";

// The SDK message types are large; these fixtures carry only the fields
// normalize.ts reads, so the one cast lives here.
const asSdkMessage = (value: object): SDKMessage => value as SDKMessage;

const assistant = (content: object[]): SDKMessage =>
  asSdkMessage({
    message: { content },
    parent_tool_use_id: null,
    session_id: "s1",
    type: "assistant",
  });

const user = (content: unknown): SDKMessage =>
  asSdkMessage({
    message: { content, role: "user" },
    parent_tool_use_id: null,
    type: "user",
  });

const resultMessage = (fields: object): SDKMessage =>
  asSdkMessage({ session_id: "s1", type: "result", ...fields });

const BASE_RESULT = {
  duration_api_ms: 1,
  duration_ms: 1,
  is_error: false,
  modelUsage: {},
  num_turns: 1,
  permission_denials: [],
  stop_reason: "end_turn",
  total_cost_usd: 0.25,
  usage: { input_tokens: 10, output_tokens: 4 },
  uuid: "00000000-0000-0000-0000-000000000000",
};

describe("normalizeMessage", () => {
  test("assistant text yields one message.assistant event", () => {
    const events = normalizeMessage(
      assistant([{ text: "hello", type: "text" }])
    );
    expect(events).toStrictEqual([
      { payload: { text: "hello" }, type: "message.assistant" },
    ]);
  });

  test("text plus tool_use in one message yields two events in order", () => {
    const events = normalizeMessage(
      assistant([
        { text: "Checking.", type: "text" },
        {
          id: "toolu_1",
          input: { file_path: "/a" },
          name: "Read",
          type: "tool_use",
        },
      ])
    );
    expect(events).toStrictEqual([
      { payload: { text: "Checking." }, type: "message.assistant" },
      {
        payload: {
          input: { file_path: "/a" },
          name: "Read",
          toolUseId: "toolu_1",
        },
        type: "tool.call",
      },
    ]);
  });

  test("thinking blocks and empty text are ignored", () => {
    const events = normalizeMessage(
      assistant([
        { signature: "sig", thinking: "hmm", type: "thinking" },
        { text: "", type: "text" },
      ])
    );
    expect(events).toStrictEqual([]);
  });

  test("tool_use with a non-object input falls back to {}", () => {
    const events = normalizeMessage(
      assistant([{ id: "t", input: "ls", name: "Bash", type: "tool_use" }])
    );
    expect(events[0]?.payload).toStrictEqual({
      input: {},
      name: "Bash",
      toolUseId: "t",
    });
  });

  test("user tool_result with string content yields tool.result", () => {
    const events = normalizeMessage(
      user([
        { content: "file body", tool_use_id: "toolu_1", type: "tool_result" },
      ])
    );
    expect(events).toStrictEqual([
      {
        payload: { ok: true, output: "file body", toolUseId: "toolu_1" },
        type: "tool.result",
      },
    ]);
  });

  test("tool_result with array content and is_error joins blocks", () => {
    const events = normalizeMessage(
      user([
        {
          content: [
            { text: "failed", type: "text" },
            { source: {}, type: "image" },
            { text: "retry", type: "text" },
          ],
          is_error: true,
          tool_use_id: "toolu_2",
          type: "tool_result",
        },
      ])
    );
    expect(events).toStrictEqual([
      {
        payload: {
          ok: false,
          output: "failed\n[image]\nretry",
          toolUseId: "toolu_2",
        },
        type: "tool.result",
      },
    ]);
  });

  test("plain user text yields nothing", () => {
    expect(normalizeMessage(user("do the task"))).toStrictEqual([]);
  });

  test("system, stream and result messages yield nothing", () => {
    expect(
      normalizeMessage(asSdkMessage({ subtype: "init", type: "system" }))
    ).toStrictEqual([]);
    expect(
      normalizeMessage(resultMessage({ result: "x", subtype: "success" }))
    ).toStrictEqual([]);
  });
});

describe("sessionIdOf", () => {
  test("returns the session id from a system init message", () => {
    const init = asSdkMessage({
      session_id: "sdk-42",
      subtype: "init",
      type: "system",
    });
    expect(sessionIdOf(init)).toBe("sdk-42");
  });

  test("is undefined for other messages", () => {
    expect(sessionIdOf(assistant([]))).toBeUndefined();
    expect(
      sessionIdOf(asSdkMessage({ subtype: "status", type: "system" }))
    ).toBeUndefined();
  });
});

describe("summariseResult", () => {
  test("success result carries the result text and usage", () => {
    const summary = summariseResult(
      resultMessage({ ...BASE_RESULT, result: "Done.", subtype: "success" })
    );
    expect(summary).toStrictEqual({
      isError: false,
      sessionId: "s1",
      text: "Done.",
      usage: { costUsd: 0.25, inputTokens: 10, outputTokens: 4 },
    });
  });

  test("error_max_turns without errors uses the subtype name", () => {
    const summary = summariseResult(
      resultMessage({
        ...BASE_RESULT,
        errors: [],
        is_error: true,
        subtype: "error_max_turns",
      })
    );
    expect(summary?.isError).toBe(true);
    expect(summary?.text).toBe("error_max_turns");
  });

  test("error_during_execution joins the errors", () => {
    const summary = summariseResult(
      resultMessage({
        ...BASE_RESULT,
        errors: ["first", "second"],
        is_error: true,
        subtype: "error_during_execution",
      })
    );
    expect(summary?.isError).toBe(true);
    expect(summary?.text).toBe("first\nsecond");
  });

  test("missing usage fields are left out, not written as undefined", () => {
    const summary = summariseResult(
      resultMessage({
        result: "ok",
        subtype: "success",
        usage: { input_tokens: 7 },
      })
    );
    expect(summary?.usage).toStrictEqual({ inputTokens: 7 });
  });

  test("non-finite or negative usage values are left out", () => {
    const summary = summariseResult(
      resultMessage({
        ...BASE_RESULT,
        result: "ok",
        subtype: "success",
        total_cost_usd: -1,
        usage: { input_tokens: Number.NaN, output_tokens: 3 },
      })
    );
    expect(summary?.usage).toStrictEqual({ outputTokens: 3 });
  });

  test("non-result messages yield undefined", () => {
    expect(summariseResult(assistant([]))).toBeUndefined();
  });
});
