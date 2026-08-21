import { describe, expect, test } from "bun:test";
import type { MessageView } from "#/modules/messaging/service";
import type { MemberAuthorView } from "#/modules/workspaces/authors";
import { authorNameOf, clampLimit, snippetOf, toMcpMessage } from "./format";

const NAMES = new Map([["agent-1", "Researcher"]]);

const message = (overrides: Partial<MessageView> = {}): MessageView => ({
  attachments: [],
  author: null,
  authorId: "agent-1",
  authorType: "agent",
  body: "hello",
  channelId: "channel-1",
  createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  id: "message-1",
  mentions: [],
  origin: "native",
  question: null,
  replyCount: 0,
  threadParentId: null,
  ...overrides,
});

const human = (name: string): MemberAuthorView => ({
  email: "ada@example.com",
  imageUrl: null,
  memberId: "member-1",
  name,
});

describe("authorNameOf", () => {
  test("names agents from the roster and humans from their membership", () => {
    expect(authorNameOf(message(), NAMES)).toBe("Researcher");
    expect(
      authorNameOf(
        message({
          author: human("Ada Lovelace"),
          authorId: "member-1",
          authorType: "user",
        }),
        NAMES
      )
    ).toBe("Ada Lovelace");
  });

  test("survives a deleted agent", () => {
    expect(authorNameOf(message({ authorId: "gone" }), NAMES)).toBe(
      "Deleted agent"
    );
  });

  test("falls back for a human with no membership left", () => {
    expect(
      authorNameOf(message({ authorId: "", authorType: "user" }), NAMES)
    ).toBe("A former member");
  });

  test("does not try to name a bridged author", () => {
    expect(
      authorNameOf(message({ authorId: "U123", authorType: "external" }), NAMES)
    ).toBe("Someone outside the workspace");
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

describe("snippetOf", () => {
  const body = (
    filler: string,
    needle: string,
    where: "start" | "middle" | "end"
  ) => {
    const pad = filler.repeat(50);
    if (where === "start") {
      return `${needle} ${pad}`;
    }
    if (where === "end") {
      return `${pad} ${needle}`;
    }
    return `${pad} ${needle} ${pad}`;
  };

  test("returns a short body whole, with no ellipsis", () => {
    expect(snippetOf("deploy went fine", "deploy")).toBe("deploy went fine");
  });

  test("keeps the head when the match is at the start", () => {
    const text = body("ab", "deploy", "start");
    const result = snippetOf(text, "deploy", 20);

    expect(result.startsWith("deploy")).toBe(true);
    expect(result.endsWith("…")).toBe(true);
    expect(result).toContain("deploy");
  });

  test("centres the window on a match in the middle", () => {
    const text = body("ab", "deploy", "middle");
    const result = snippetOf(text, "deploy", 20);

    expect(result).toContain("deploy");
    expect(result.startsWith("…")).toBe(true);
    expect(result.endsWith("…")).toBe(true);
  });

  test("keeps the tail when the match is at the end", () => {
    const text = body("ab", "deploy", "end");
    const result = snippetOf(text, "deploy", 20);

    expect(result).toContain("deploy");
    expect(result.startsWith("…")).toBe(true);
    expect(result.endsWith("…")).toBe(false);
  });

  test("never exceeds the window bar the ellipses it adds", () => {
    const text = body("ab", "deploy", "middle");
    expect(snippetOf(text, "deploy", 20).replaceAll("…", "").length).toBe(20);
  });

  test("folds case, because the search that found the hit did", () => {
    const text = body("ab", "DEPLOY", "middle");
    expect(snippetOf(text, "deploy", 20)).toContain("DEPLOY");
  });

  test("falls back to the head when the match cannot be located", () => {
    const text = body("ab", "deploy", "end");
    const result = snippetOf(text, "nowhere in this body", 20);

    expect(result.startsWith("ab")).toBe(true);
    expect(result.startsWith("…")).toBe(false);
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
