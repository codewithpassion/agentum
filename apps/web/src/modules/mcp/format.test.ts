import { describe, expect, test } from "bun:test";
import type { MessageView } from "#/modules/messaging/service";
import { authorNameOf, clampLimit, toMcpMessage } from "./format";

const NAMES = new Map([["agent-1", "Researcher"]]);

const message = (overrides: Partial<MessageView> = {}): MessageView => ({
  attachments: [],
  authorId: "agent-1",
  authorType: "agent",
  body: "hello",
  channelId: "channel-1",
  createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  id: "message-1",
  mentions: [],
  origin: "native",
  replyCount: 0,
  threadParentId: null,
  ...overrides,
});

describe("authorNameOf", () => {
  test("names agents and collapses humans", () => {
    expect(authorNameOf(message(), NAMES)).toBe("Researcher");
    expect(
      authorNameOf(message({ authorId: "user_123", authorType: "user" }), NAMES)
    ).toBe("User");
  });

  test("survives a deleted agent", () => {
    expect(authorNameOf(message({ authorId: "gone" }), NAMES)).toBe(
      "Deleted agent"
    );
  });
});

describe("toMcpMessage", () => {
  test("keeps only what an agent can act on", () => {
    expect(
      toMcpMessage(
        message({
          attachments: [
            {
              filename: "notes.pdf",
              id: "attachment-1",
              mime: "application/pdf",
              size: 12,
              url: "/api/attachments/attachment-1",
            },
          ],
          mentions: [{ agentId: "agent-2", name: "Chief of Staff" }],
          replyCount: 2,
          threadParentId: "message-0",
        }),
        NAMES
      )
    ).toEqual({
      attachments: [{ filename: "notes.pdf", id: "attachment-1" }],
      author: { id: "agent-1", name: "Researcher", type: "agent" },
      body: "hello",
      createdAt: "2026-01-02T03:04:05.000Z",
      id: "message-1",
      mentions: ["Chief of Staff"],
      replyCount: 2,
      threadParentId: "message-0",
    });
  });
});

describe("clampLimit", () => {
  test("falls back and caps", () => {
    const bounds = { fallback: 30, max: 100 };
    expect(clampLimit(undefined, bounds)).toBe(30);
    expect(clampLimit(0, bounds)).toBe(30);
    expect(clampLimit(-5, bounds)).toBe(30);
    expect(clampLimit(Number.NaN, bounds)).toBe(30);
    expect(clampLimit(10, bounds)).toBe(10);
    expect(clampLimit(10.7, bounds)).toBe(10);
    expect(clampLimit(5000, bounds)).toBe(100);
  });
});
