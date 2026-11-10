import { expect, test } from "bun:test";
import type { ThreadMessage, ThreadStatus } from "@repo/protocol/thread";
import {
  fileIdsOfAppend,
  isActiveStatus,
  latestUserMessage,
  replyBody,
  replyNote,
  startRunBody,
  textOfAppend,
} from "./thread-send.ts";

const text = (value: string) => ({ text: value, type: "text" as const });
const image = { image: "data:image/png;base64,AAAA", type: "image" as const };
const file = (data: string) => ({
  data,
  filename: `${data}.pdf`,
  mimeType: "application/pdf",
  type: "file" as const,
});
const attachment = (...parts: (ReturnType<typeof file> | typeof image)[]) => ({
  content: parts,
  id: "att",
  name: "att",
  status: { type: "complete" as const },
  type: "file",
});

test("textOfAppend joins text parts with a newline", () => {
  expect(
    textOfAppend({ content: [text("first"), text("second"), text("third")] })
  ).toBe("first\nsecond\nthird");
});

test("textOfAppend ignores non-text parts", () => {
  expect(
    textOfAppend({ content: [text("look"), image, text("at this")] })
  ).toBe("look\nat this");
});

test("textOfAppend trims surrounding whitespace", () => {
  expect(textOfAppend({ content: [text("  hello  \n")] })).toBe("hello");
  expect(textOfAppend({ content: [text("   ")] })).toBe("");
});

test("fileIdsOfAppend is empty when attachments are undefined", () => {
  expect(fileIdsOfAppend({ attachments: undefined })).toEqual([]);
});

test("fileIdsOfAppend returns file ids of every attachment in order", () => {
  expect(
    fileIdsOfAppend({
      attachments: [attachment(file("f1"), file("f2")), attachment(file("f3"))],
    })
  ).toEqual(["f1", "f2", "f3"]);
});

test("fileIdsOfAppend drops duplicate ids", () => {
  expect(
    fileIdsOfAppend({
      attachments: [attachment(file("f1")), attachment(file("f1"), file("f2"))],
    })
  ).toEqual(["f1", "f2"]);
});

test("fileIdsOfAppend skips parts that are not files", () => {
  expect(
    fileIdsOfAppend({
      attachments: [attachment(image, file("f1"))],
    })
  ).toEqual(["f1"]);
});

test("startRunBody falls back to the session id when externalKey is null", () => {
  expect(
    startRunBody({
      agentId: "agent-1",
      fileIds: ["f1"],
      requestId: "req-1",
      session: { externalKey: null, id: "sess-1" },
      text: "hi",
    })
  ).toEqual({
    agentId: "agent-1",
    input: { fileIds: ["f1"], text: "hi" },
    requestId: "req-1",
    session: { externalKey: "sess-1", origin: "ui" },
  });
});

test("startRunBody keeps a set externalKey", () => {
  expect(
    startRunBody({
      agentId: "agent-1",
      fileIds: [],
      requestId: "req-2",
      session: { externalKey: "ext-9", id: "sess-1" },
      text: "hi",
    }).session
  ).toEqual({ externalKey: "ext-9", origin: "ui" });
});

test("replyNote is null for the ui origin", () => {
  expect(replyNote("ui")).toBeNull();
});

test("replyNote explains where to reply for each other origin", () => {
  expect(replyNote("slack")).toBe(
    "This thread belongs to a Slack conversation. Reply there."
  );
  expect(replyNote("inbox")).toBe(
    "This thread belongs to an inbox conversation. Reply in the inbox."
  );
  expect(replyNote("routine")).toBe(
    "A routine started this thread, so it has no reply here."
  );
  expect(replyNote("trigger")).toBe(
    "A trigger started this thread, so it has no reply here."
  );
  expect(replyNote("mcp")).toBe(
    "An MCP client started this thread. Reply from that client."
  );
  expect(replyNote("elsewhere")).toBe("This thread is read only here.");
});

const message = (id: string, role: ThreadMessage["role"]) => ({ id, role });

test("latestUserMessage is null without user messages", () => {
  expect(latestUserMessage([])).toBeNull();
  expect(latestUserMessage([message("a1", "assistant")])).toBeNull();
});

test("latestUserMessage returns the only user message", () => {
  expect(latestUserMessage([message("u1", "user")])).toBe("u1");
});

test("latestUserMessage returns the last user message of several", () => {
  expect(
    latestUserMessage([
      message("u1", "user"),
      message("a1", "assistant"),
      message("u2", "user"),
      message("a2", "assistant"),
    ])
  ).toBe("u2");
});

test("isActiveStatus is true for running and waiting only", () => {
  const cases: [ThreadStatus, boolean][] = [
    ["running", true],
    ["waiting", true],
    ["done", false],
    ["failed", false],
    ["cancelled", false],
  ];
  for (const [status, active] of cases) {
    expect(isActiveStatus(status)).toBe(active);
  }
});

test("a sub-thread replies here whatever its origin, and sends by session id", () => {
  expect(replyNote("mcp", true)).toBeNull();
  expect(replyNote("mcp", false)).not.toBeNull();
  expect(
    replyBody({
      fileIds: ["f1"],
      requestId: "req-1",
      sessionId: "sess-9",
      text: "hi",
    })
  ).toEqual({
    input: { fileIds: ["f1"], text: "hi" },
    requestId: "req-1",
    sessionId: "sess-9",
  });
});
