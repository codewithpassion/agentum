import { describe, expect, test } from "bun:test";
import { decideWakes, type MessageNotification } from "./wake-decision";

const notification = (
  overrides: Partial<MessageNotification> = {}
): MessageNotification => ({
  authorId: "user_1",
  authorName: "User",
  authorType: "user",
  body: "hello",
  channelId: "channel_1",
  channelKind: "channel",
  channelName: "ops",
  createdAt: 1000,
  memberAgentIds: ["cos", "researcher"],
  mentionedAgentIds: [],
  messageId: "message_1",
  threadParentId: null,
  ...overrides,
});

const kindOf = (
  targets: ReturnType<typeof decideWakes>,
  agentId: string
): string | undefined =>
  targets.find((target) => target.agentId === agentId)?.kind;

describe("decideWakes", () => {
  test("wakes a mentioned member immediately and the rest by digest", () => {
    const targets = decideWakes(notification({ mentionedAgentIds: ["cos"] }));

    expect(kindOf(targets, "cos")).toBe("immediate");
    expect(kindOf(targets, "researcher")).toBe("digest");
  });

  test("wakes every agent in a DM immediately", () => {
    const targets = decideWakes(
      notification({ channelKind: "dm", memberAgentIds: ["cos"] })
    );

    expect(kindOf(targets, "cos")).toBe("immediate");
  });

  test("never wakes an agent on its own message", () => {
    const targets = decideWakes(
      notification({
        authorId: "cos",
        authorType: "agent",
        mentionedAgentIds: ["cos", "researcher"],
      })
    );

    expect(kindOf(targets, "cos")).toBeUndefined();
    expect(kindOf(targets, "researcher")).toBe("immediate");
  });

  test("wakes an agent mentioned by another agent", () => {
    const targets = decideWakes(
      notification({
        authorId: "cos",
        authorType: "agent",
        mentionedAgentIds: ["researcher"],
      })
    );

    expect(kindOf(targets, "researcher")).toBe("immediate");
  });

  test("ignores a mention of an agent that is not in the channel", () => {
    const targets = decideWakes(
      notification({ mentionedAgentIds: ["outsider"] })
    );

    expect(kindOf(targets, "outsider")).toBeUndefined();
    expect(targets.every((target) => target.kind === "digest")).toBe(true);
  });

  test("wakes nobody in a channel with no agents", () => {
    expect(decideWakes(notification({ memberAgentIds: [] }))).toEqual([]);
  });

  test("wakes a DM partner even when the human authored it", () => {
    const targets = decideWakes(
      notification({
        authorId: "user_1",
        authorType: "user",
        channelKind: "dm",
        memberAgentIds: ["cos"],
      })
    );

    expect(kindOf(targets, "cos")).toBe("immediate");
  });
});
