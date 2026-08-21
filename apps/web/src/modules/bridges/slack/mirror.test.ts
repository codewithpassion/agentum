import { describe, expect, test } from "bun:test";
import type { MessageView } from "#/modules/messaging/service";
import type { QuestionView } from "#/modules/questions/view";
import { DEFAULT_WORKSPACE_ID } from "#/modules/workspaces/service";
import type { ChannelBridge } from "../schema";
import type {
  SlackClient,
  SlackPostMessageInput,
  SlackUpdateMessageInput,
  SlackUploadInput,
} from "./client";
import {
  mirrorQuestionResolution,
  mirrorSlackMessage,
  type SlackOutboundPorts,
} from "./mirror";

const SLACK_CHANNEL = "C0OPSCHAN";

const bridge = (overrides: Partial<ChannelBridge> = {}): ChannelBridge => ({
  agentId: "agent-1",
  channelId: "channel-1",
  connector: "slack",
  createdAt: new Date(0),
  externalChannelId: SLACK_CHANNEL,
  id: "bridge-1",
  slackAppId: "slack-app-1",
  status: "active",
  workspaceId: DEFAULT_WORKSPACE_ID,
  ...overrides,
});

const message = (overrides: Partial<MessageView> = {}): MessageView => ({
  attachments: [],
  author: null,
  authorId: "agent-1",
  authorType: "agent",
  body: "on it",
  channelId: "channel-1",
  createdAt: 0,
  id: "message-1",
  mentions: [],
  origin: "native",
  question: null,
  replyCount: 0,
  threadParentId: null,
  ...overrides,
});

interface Recorded {
  posts: SlackPostMessageInput[];
  updates: SlackUpdateMessageInput[];
  uploads: SlackUploadInput[];
}

const recorder = (): Recorded => ({ posts: [], updates: [], uploads: [] });

const client = (
  recorded: Recorded,
  postResult: { ts: string } | null = { ts: "1787200000.000900" }
): SlackClient => ({
  chatUpdate: (input) => {
    recorded.updates.push(input);
    return Promise.resolve(true);
  },
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
  parentKeys: Record<string, string> = {},
  link: string | null = "https://agentum.example.com/w/alpha?channel=channel-1"
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
  webLink: () => Promise.resolve(link),
});

/** The buttons of a card: the second block, when the card has one. */
const actionElements = (
  blocks: readonly unknown[] | undefined
): { url?: string }[] => {
  const actions = ((blocks ?? [])[1] ?? {}) as {
    elements?: { url?: string }[];
  };
  return actions.elements ?? [];
};

const question = (overrides: Partial<QuestionView> = {}): QuestionView => ({
  agentId: "agent-1",
  answer: null,
  answeredAt: null,
  answeredBy: null,
  answeredVia: null,
  channelId: "channel-1",
  createdAt: 0,
  expiresAt: null,
  id: "question-1",
  kind: "question",
  messageId: "message-1",
  options: ["Postgres", "SQLite"],
  prompt: "Which database?",
  status: "pending",
  ...overrides,
});

describe("mirrorSlackMessage", () => {
  test("posts a workspace message to the bridged Slack channel", async () => {
    const recorded = recorder();

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
    const recorded = recorder();

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
    const recorded = recorder();

    await mirrorSlackMessage(
      message({ id: "message-2", threadParentId: "message-1" }),
      bridge(),
      client(recorded),
      ports({ "message-1": `${SLACK_CHANNEL}:1787200000.000100` })
    );

    expect(recorded.posts[0]?.threadTs).toBe("1787200000.000100");
  });

  test("posts at the top level when the parent was never mirrored", async () => {
    const recorded = recorder();

    await mirrorSlackMessage(
      message({ threadParentId: "message-unknown" }),
      bridge(),
      client(recorded),
      ports()
    );

    expect(recorded.posts[0]?.threadTs).toBeUndefined();
  });

  test("re-uploads attachments into the same thread", async () => {
    const recorded = recorder();

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
    const recorded = recorder();

    const ref = await mirrorSlackMessage(
      message(),
      bridge(),
      client(recorded, null),
      ports()
    );

    expect(ref).toBeNull();
  });

  test("posts a question as a card, not as its text", async () => {
    const recorded = recorder();

    await mirrorSlackMessage(
      message({ origin: "question", question: question() }),
      bridge(),
      client(recorded),
      ports()
    );

    // The fallback text is the prompt itself - unprefixed, because a question
    // card is the agent speaking as the bot, and blocks carry the rest.
    expect(recorded.posts[0]?.text).toBe("Which database?");
    expect(recorded.posts[0]?.blocks).toHaveLength(2);
    expect(actionElements(recorded.posts[0]?.blocks)).toHaveLength(2);
  });

  test("offers a deep link when the question has no options", async () => {
    const recorded = recorder();

    await mirrorSlackMessage(
      message({ origin: "question", question: question({ options: null }) }),
      bridge(),
      client(recorded),
      ports()
    );

    // Slack has no free-text answer in a message; the card sends you to the app.
    expect(actionElements(recorded.posts[0]?.blocks)[0]?.url).toBe(
      "https://agentum.example.com/w/alpha?channel=channel-1"
    );
  });

  test("skips a disabled bridge", async () => {
    const recorded = recorder();

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

describe("mirrorQuestionResolution", () => {
  test("rewrites the card with who answered, and no buttons", async () => {
    const recorded = recorder();

    await mirrorQuestionResolution(
      question({
        answer: "Postgres",
        answeredBy: { id: "member-1", name: "Ada" },
        answeredVia: "web",
        status: "answered",
      }),
      bridge(),
      client(recorded),
      `${SLACK_CHANNEL}:1787200000.000100`
    );

    expect(recorded.updates[0]?.ts).toBe("1787200000.000100");
    expect(recorded.updates[0]?.channel).toBe(SLACK_CHANNEL);
    expect(recorded.updates[0]?.blocks).toHaveLength(2);
    // A context line where the actions block was: nothing left to press.
    expect(JSON.stringify(recorded.updates[0]?.blocks)).toContain(
      "Answered by Ada"
    );
    expect(JSON.stringify(recorded.updates[0]?.blocks)).not.toContain("button");
  });

  test("says so when the question expired", async () => {
    const recorded = recorder();

    await mirrorQuestionResolution(
      question({ status: "expired" }),
      bridge(),
      client(recorded),
      `${SLACK_CHANNEL}:1787200000.000100`
    );

    expect(JSON.stringify(recorded.updates[0]?.blocks)).toContain("Expired");
  });

  test("leaves a disabled bridge alone", async () => {
    const recorded = recorder();

    await mirrorQuestionResolution(
      question({ status: "expired" }),
      bridge({ status: "disabled" }),
      client(recorded),
      `${SLACK_CHANNEL}:1787200000.000100`
    );

    expect(recorded.updates).toEqual([]);
  });
});
