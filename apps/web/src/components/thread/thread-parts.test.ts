import { expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ArtifactThreadPart } from "@repo/protocol/artifacts";
import type {
  RequestPart,
  ThreadMessage,
  ThreadStatus,
} from "@repo/protocol/thread";
import { messageStatusOf, toThreadMessageLike } from "./thread-parts.ts";
import { fileIdsOfAppend } from "./thread-send.ts";

const assistant = (
  parts: ThreadMessage["parts"],
  overrides: Partial<ThreadMessage> = {}
): ThreadMessage => ({
  createdAt: "2026-10-26T10:00:00.000Z",
  id: "m-assistant",
  parts,
  role: "assistant",
  runId: "run-1",
  status: "done",
  ...overrides,
});

const user = (
  parts: ThreadMessage["parts"],
  overrides: Partial<ThreadMessage> = {}
): ThreadMessage => ({
  createdAt: "2026-10-26T09:00:00.000Z",
  id: "m-user",
  parts,
  role: "user",
  runId: null,
  status: "done",
  ...overrides,
});

test("every thread status maps to an assistant-ui status", () => {
  const expected: [ThreadStatus, NonNullable<ThreadMessageLike["status"]>][] = [
    ["cancelled", { reason: "cancelled", type: "incomplete" }],
    ["done", { reason: "stop", type: "complete" }],
    ["failed", { reason: "error", type: "incomplete" }],
    ["running", { type: "running" }],
    ["waiting", { reason: "interrupt", type: "requires-action" }],
  ];
  for (const [status, mapped] of expected) {
    expect(messageStatusOf(status)).toEqual(mapped);
  }
});

test("an assistant message maps text, reasoning, tool calls, requests and placeholders", () => {
  const request: RequestPart = {
    display: {
      input: { to: "a@example.com" },
      summary: "Send the email?",
      toolKey: "mail.send",
      toolName: "send_email",
    },
    expiresAt: "2026-10-26T11:00:00.000Z",
    kind: "approval",
    requestId: "req-1",
    status: "pending",
    toolUseId: "tool-2",
    type: "request",
  };

  const result = toThreadMessageLike(
    assistant(
      [
        { text: "Hello", type: "text" },
        { text: "Thinking it over", type: "reasoning" },
        {
          input: { path: "a.txt" },
          name: "read",
          ok: null,
          result: null,
          toolUseId: "tool-1",
          type: "tool-call",
        },
        {
          input: { q: "x" },
          name: "search",
          ok: true,
          result: { hits: 3 },
          toolUseId: "tool-2",
          type: "tool-call",
        },
        {
          input: {},
          name: null,
          ok: false,
          result: "boom",
          toolUseId: "tool-3",
          type: "tool-call",
        },
        request,
        { eventId: "evt-9", eventType: "tool.result", type: "placeholder" },
      ],
      { status: "waiting" }
    )
  );

  expect(result).toEqual({
    content: [
      { text: "Hello", type: "text" },
      { text: "Thinking it over", type: "reasoning" },
      {
        args: { path: "a.txt" },
        isError: false,
        result: undefined,
        toolCallId: "tool-1",
        toolName: "read",
        type: "tool-call",
      },
      {
        args: { q: "x" },
        isError: false,
        result: { hits: 3 },
        toolCallId: "tool-2",
        toolName: "search",
        type: "tool-call",
      },
      {
        args: {},
        isError: true,
        result: "boom",
        toolCallId: "tool-3",
        toolName: "tool",
        type: "tool-call",
      },
      { data: { requestId: "req-1" }, type: "data-request" },
      { text: "(content too large to show)", type: "text" },
    ],
    createdAt: new Date("2026-10-26T10:00:00.000Z"),
    id: "m-assistant",
    metadata: { custom: { runId: "run-1" } },
    role: "assistant",
    status: { reason: "interrupt", type: "requires-action" },
  });
});

test("a tool call input that is an array or a string keeps its text in argsText", () => {
  const array = toThreadMessageLike(
    assistant([
      {
        input: [1, 2],
        name: "sum",
        ok: true,
        result: 3,
        toolUseId: "t-arr",
        type: "tool-call",
      },
    ])
  );
  const text = toThreadMessageLike(
    assistant([
      {
        input: "ls -la",
        name: "bash",
        ok: true,
        result: "",
        toolUseId: "t-str",
        type: "tool-call",
      },
    ])
  );

  expect(array.content).toEqual([
    {
      args: {},
      argsText: "[1,2]",
      isError: false,
      result: 3,
      toolCallId: "t-arr",
      toolName: "sum",
      type: "tool-call",
    },
  ]);
  expect(text.content).toEqual([
    {
      args: {},
      argsText: '"ls -la"',
      isError: false,
      result: "",
      toolCallId: "t-str",
      toolName: "bash",
      type: "tool-call",
    },
  ]);
});

test("a user message keeps its text and turns fileId attachments into attachments", () => {
  const result = toThreadMessageLike(
    user([
      { text: "See these", type: "text" },
      { fileId: "file-a", type: "attachment" },
      { fileId: "file-b", type: "attachment" },
    ])
  );

  expect(result).toEqual({
    attachments: [
      {
        content: [
          {
            data: "file-a",
            filename: "file-a",
            mimeType: "application/octet-stream",
            type: "file",
          },
        ],
        id: "file-a",
        name: "file-a",
        status: { type: "complete" },
        type: "file",
      },
      {
        content: [
          {
            data: "file-b",
            filename: "file-b",
            mimeType: "application/octet-stream",
            type: "file",
          },
        ],
        id: "file-b",
        name: "file-b",
        status: { type: "complete" },
        type: "file",
      },
    ],
    content: [{ text: "See these", type: "text" }],
    createdAt: new Date("2026-10-26T09:00:00.000Z"),
    id: "m-user",
    metadata: { custom: { runId: null } },
    role: "user",
  });
  expect(result).not.toHaveProperty("status");
});

test("a user message without attachments has no attachments field", () => {
  const result = toThreadMessageLike(user([{ text: "Hi", type: "text" }]));
  expect(result).not.toHaveProperty("attachments");
  expect(result).not.toHaveProperty("status");
});

test("an assistant message turns fileId and path attachments into data parts", () => {
  const result = toThreadMessageLike(
    assistant([
      { fileId: "file-a", type: "attachment" },
      { path: "/work/out.csv", type: "attachment" },
    ])
  );

  expect(result.content).toEqual([
    { data: { fileId: "file-a" }, type: "data-attachment" },
    { data: { path: "/work/out.csv" }, type: "data-attachment" },
  ]);
  expect(result).not.toHaveProperty("attachments");
});

const artifactPart: ArtifactThreadPart = {
  artifactId: "3f0c8a7e-6b1d-4c2a-9e5f-1a2b3c4d5e6f",
  kind: "doc",
  title: "Q4 plan",
  toolCallId: "tool-1",
  type: "artifact",
  version: 2,
  versionId: "ver-2",
};

test("an assistant message maps an artifact part to a data-artifact after its tool call", () => {
  const parts: ThreadMessage["parts"] = [
    { text: "Here it is", type: "text" },
    {
      input: { q: "plan" },
      name: "write",
      ok: true,
      result: "saved",
      toolUseId: "tool-1",
      type: "tool-call",
    },
    artifactPart,
  ];

  const result = toThreadMessageLike(assistant(parts));

  expect(result.content).toEqual([
    { text: "Here it is", type: "text" },
    {
      args: { q: "plan" },
      isError: false,
      result: "saved",
      toolCallId: "tool-1",
      toolName: "write",
      type: "tool-call",
    },
    {
      data: {
        artifactId: "3f0c8a7e-6b1d-4c2a-9e5f-1a2b3c4d5e6f",
        kind: "doc",
        title: "Q4 plan",
        version: 2,
        versionId: "ver-2",
      },
      type: "data-artifact",
    },
  ]);
});

test("a user message maps an artifact part to no content", () => {
  const parts: ThreadMessage["parts"] = [
    { text: "Look", type: "text" },
    artifactPart,
  ];

  const result = toThreadMessageLike(user(parts));

  expect(result.content).toEqual([{ text: "Look", type: "text" }]);
});

test("a null createdAt gives an undefined createdAt", () => {
  const result = toThreadMessageLike(
    assistant([{ text: "live", type: "text" }], { createdAt: null })
  );
  expect(result.createdAt).toBeUndefined();
});

test("converting does not change the input message", () => {
  const input = assistant(
    [
      {
        input: { a: 1 },
        name: "t",
        ok: true,
        result: { r: 1 },
        toolUseId: "tu",
        type: "tool-call",
      },
      { fileId: "f", type: "attachment" },
    ],
    { status: "running" }
  );
  const frozenTool = Object.freeze({
    input: Object.freeze({ a: 1 }),
    name: "t",
    ok: true,
    result: Object.freeze({ r: 1 }),
    toolUseId: "tu",
    type: "tool-call" as const,
  });
  const frozen: ThreadMessage = Object.freeze({
    ...input,
    parts: Object.freeze([
      frozenTool,
      Object.freeze({ fileId: "f", type: "attachment" as const }),
    ]) as ThreadMessage["parts"],
  });

  const first = toThreadMessageLike(frozen);
  const second = toThreadMessageLike(frozen);

  expect(first).toEqual(second);
  expect(first).not.toBe(second);
  expect(frozen.parts).toHaveLength(2);
  expect(frozen.status).toBe("running");
});

test("the file ids of a user message come back out of its attachments", () => {
  const result = toThreadMessageLike(
    user([
      { text: "See these", type: "text" },
      { fileId: "file-a", type: "attachment" },
      { fileId: "file-b", type: "attachment" },
    ])
  );
  const attachments = (result.attachments ?? []).map((item) => ({
    ...item,
    content: [...item.content],
  }));
  expect(
    fileIdsOfAppend({ attachments } as Parameters<typeof fileIdsOfAppend>[0])
  ).toEqual(["file-a", "file-b"]);
});
