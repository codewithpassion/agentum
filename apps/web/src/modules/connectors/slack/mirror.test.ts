import { describe, expect, test } from "bun:test";
import type { MessageView } from "#/modules/messaging/service";
import type { ChannelBridge } from "../schema";
import type {
  SlackClient,
  SlackPostMessageInput,
  SlackUploadInput,
} from "./client";
import { mirrorSlackMessage, type SlackOutboundPorts } from "./mirror";

const SLACK_CHANNEL = "C0OPSCHAN";

const bridge = (overrides: Partial<ChannelBridge> = {}): ChannelBridge => ({
  agentId: "agent-1",
  channelId: "channel-1",
  connector: "slack",
  createdAt: new Date(0),
  externalChannelId: SLACK_CHANNEL,
  id: "bridge-1",
  status: "active",
  ...overrides,
});

const message = (overrides: Partial<MessageView> = {}): MessageView => ({
  attachments: [],
  authorId: "agent-1",
  authorType: "agent",
  body: "on it",
  channelId: "channel-1",
  createdAt: 0,
  id: "message-1",
  mentions: [],
  origin: "native",
  replyCount: 0,
  threadParentId: null,
  ...overrides,
});

interface Recorded {
  posts: SlackPostMessageInput[];
  uploads: SlackUploadInput[];
}

const client = (
  recorded: Recorded,
  postResult: { ts: string } | null = { ts: "1787200000.000900" }
): SlackClient => ({
  conversationsInfo: () => Promise.resolve(null),
  conversationsJoin: () => Promise.resolve(false),
  downloadFile: () => Promise.resolve(null),
  postMessage: (input) => {
    recorded.posts.push(input);
    return Promise.resolve(postResult);
  },
  uploadFile: (input) => {
    recorded.uploads.push(input);
    return Promise.resolve(true);
  },
  usersInfo: () => Promise.resolve(null),
});

const ports = (
  parentKeys: Record<string, string> = {}
): SlackOutboundPorts => ({
  authorName: (subject) =>
    Promise.resolve(subject.authorType === "agent" ? "Researcher" : null),
  readAttachment: (attachmentId) =>
    Promise.resolve({
      data: new TextEncoder().encode(`bytes:${attachmentId}`).buffer,
      filename: "report.pdf",
    }),
  resolveParentKey: (internalMessageId) =>
    Promise.resolve(parentKeys[internalMessageId] ?? null),
});

describe("mirrorSlackMessage", () => {
  test("posts a workspace message to the bridged Slack channel", async () => {
    const recorded: Recorded = { posts: [], uploads: [] };

    const ref = await mirrorSlackMessage(
      message(),
      bridge(),
      client(recorded),
      ports()
    );

    expect(recorded.posts).toEqual([
      { channel: SLACK_CHANNEL, text: "*Researcher*\non it" },
    ]);
    expect(ref).toEqual({
      externalId: `${SLACK_CHANNEL}:1787200000.000900`,
      internalId: "message-1",
      internalType: "message",
    });
  });

  test("never mirrors a message that came from Slack", async () => {
    const recorded: Recorded = { posts: [], uploads: [] };

    const ref = await mirrorSlackMessage(
      message({ origin: "slack" }),
      bridge(),
      client(recorded),
      ports()
    );

    // The echo-loop guard: mirroring this would post Slack's own message back.
    expect(ref).toBeNull();
    expect(recorded.posts).toEqual([]);
  });

  test("threads a reply under the parent's Slack ts", async () => {
    const recorded: Recorded = { posts: [], uploads: [] };

    await mirrorSlackMessage(
      message({ id: "message-2", threadParentId: "message-1" }),
      bridge(),
      client(recorded),
      ports({ "message-1": `${SLACK_CHANNEL}:1787200000.000100` })
    );

    expect(recorded.posts[0]?.threadTs).toBe("1787200000.000100");
  });

  test("posts at the top level when the parent was never mirrored", async () => {
    const recorded: Recorded = { posts: [], uploads: [] };

    await mirrorSlackMessage(
      message({ threadParentId: "message-unknown" }),
      bridge(),
      client(recorded),
      ports()
    );

    expect(recorded.posts[0]?.threadTs).toBeUndefined();
  });

  test("re-uploads attachments into the same thread", async () => {
    const recorded: Recorded = { posts: [], uploads: [] };

    await mirrorSlackMessage(
      message({
        attachments: [
          {
            filename: "report.pdf",
            id: "attachment-1",
            mime: "application/pdf",
            size: 12,
            url: "/api/attachments/attachment-1",
          },
        ],
      }),
      bridge(),
      client(recorded),
      ports()
    );

    expect(recorded.uploads).toHaveLength(1);
    expect(recorded.uploads[0]?.filename).toBe("report.pdf");
    // No parent, so the files hang off the message we just posted.
    expect(recorded.uploads[0]?.threadTs).toBe("1787200000.000900");
  });

  test("reports nothing when Slack refused the post", async () => {
    const recorded: Recorded = { posts: [], uploads: [] };

    const ref = await mirrorSlackMessage(
      message(),
      bridge(),
      client(recorded, null),
      ports()
    );

    expect(ref).toBeNull();
  });

  test("skips a disabled bridge", async () => {
    const recorded: Recorded = { posts: [], uploads: [] };

    const ref = await mirrorSlackMessage(
      message(),
      bridge({ status: "disabled" }),
      client(recorded),
      ports()
    );

    expect(ref).toBeNull();
    expect(recorded.posts).toEqual([]);
  });
});
