import { describe, expect, test } from "bun:test";
import { parseMentions } from "#/modules/messaging/mentions";
import type { ChannelBridge } from "../schema";
import type { InboundMessage } from "../types";
import type { SlackEventCallback, SlackMessageEvent } from "./events";
import {
  isPublishableEvent,
  normalizeSlackEvent,
  type SlackInboundPorts,
} from "./normalize";

/**
 * Synthetic Events API deliveries, shaped like the real ones. No network and no
 * database: the ports stand in for both.
 */

const BOT_USER_ID = "U0BOTAGENT";
const SLACK_CHANNEL = "C0OPSCHAN";
const IM_CHANNEL = "D0DMCHANN";

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

const delivery = (
  event: Partial<SlackMessageEvent>,
  overrides: Partial<SlackEventCallback> = {}
): SlackEventCallback => ({
  authorizations: [{ user_id: BOT_USER_ID }],
  event: {
    channel: SLACK_CHANNEL,
    channel_type: "channel",
    text: "hello team",
    ts: "1787200000.000100",
    type: "message",
    user: "U1ALICE",
    ...event,
  },
  event_id: "Ev0001",
  team_id: "T0WORK",
  type: "event_callback",
  ...overrides,
});

interface PortOverrides {
  duplicates?: string[];
  files?: Record<string, string | null>;
  found?: { agentName: string | null; bridge: ChannelBridge } | null;
  threadParents?: Record<string, string>;
  userNames?: Record<string, string>;
}

const ports = (
  overrides: PortOverrides = {}
): SlackInboundPorts & { storedFiles: string[] } => {
  const storedFiles: string[] = [];
  return {
    findBridge: (externalChannelId) => {
      const found =
        overrides.found === undefined
          ? { agentName: "Chief of Staff", bridge: bridge() }
          : overrides.found;
      if (found && found.bridge.externalChannelId !== externalChannelId) {
        return Promise.resolve(null);
      }
      return Promise.resolve(found);
    },
    isDuplicate: (externalId) =>
      Promise.resolve((overrides.duplicates ?? []).includes(externalId)),
    resolveThreadParent: (externalId) =>
      Promise.resolve(overrides.threadParents?.[externalId] ?? null),
    resolveUserNames: (userIds) =>
      Promise.resolve(
        new Map(
          userIds.flatMap((id) => {
            const name = overrides.userNames?.[id];
            return name ? [[id, name] as const] : [];
          })
        )
      ),
    storedFiles,
    storeFile: (file) => {
      storedFiles.push(file.id);
      return Promise.resolve(overrides.files?.[file.id] ?? null);
    },
  };
};

/** Fails with a readable message instead of asserting through `?.`. */
const published = (inbound: InboundMessage | null): InboundMessage => {
  if (!inbound) {
    throw new Error("Expected the event to produce a message.");
  }
  return inbound;
};

describe("isPublishableEvent", () => {
  test("takes subtype-less messages and app mentions only", () => {
    const base = { channel: SLACK_CHANNEL, ts: "1.1", user: "U1ALICE" };

    expect(isPublishableEvent({ ...base, type: "message" })).toBe(true);
    expect(isPublishableEvent({ ...base, type: "app_mention" })).toBe(true);
    expect(
      isPublishableEvent({
        ...base,
        subtype: "message_changed",
        type: "message",
      })
    ).toBe(false);
    expect(isPublishableEvent({ ...base, type: "reaction_added" })).toBe(false);
    expect(
      isPublishableEvent({ channel: SLACK_CHANNEL, type: "message" })
    ).toBe(false);
  });
});

describe("normalizeSlackEvent", () => {
  test("normalises a channel message into an internal message", async () => {
    const inbound = await normalizeSlackEvent(delivery({}), ports());

    expect(inbound).toEqual({
      externalId: `${SLACK_CHANNEL}:1787200000.000100`,
      input: {
        attachmentIds: [],
        authorId: "slack:U1ALICE",
        authorType: "external",
        body: "hello team",
        channelId: "channel-1",
        origin: "slack",
      },
    });
  });

  test("translates the bot mention into the bridged agent's @Name", async () => {
    const inbound = await normalizeSlackEvent(
      delivery({
        text: "<@U0BOTAGENT> please brief <@U2BOB>",
        type: "app_mention",
      }),
      ports({ userNames: { U2BOB: "bob" } })
    );

    expect(published(inbound).input.body).toBe(
      "@Chief of Staff please brief @bob"
    );
  });

  test("produces a body the mention parser wakes the agent on", async () => {
    const inbound = await normalizeSlackEvent(
      delivery({ text: "<@U0BOTAGENT> status?", type: "app_mention" }),
      ports()
    );

    // The whole inbound path hinges on this: `createMessage` runs the same
    // parser over the body, and only a match creates the mention the router
    // wakes on. Multi-word agent names are why the translation cannot just be
    // a bare handle.
    expect(
      parseMentions(published(inbound).input.body, [
        { id: "agent-1", name: "Chief of Staff" },
      ])
    ).toEqual([{ id: "agent-1", index: 0, name: "Chief of Staff" }]);
  });

  test("hangs a threaded reply off the parent we already published", async () => {
    const inbound = await normalizeSlackEvent(
      delivery({
        text: "and one more thing",
        thread_ts: "1787200000.000100",
        ts: "1787200000.000200",
      }),
      ports({
        threadParents: { [`${SLACK_CHANNEL}:1787200000.000100`]: "message-1" },
      })
    );

    expect(published(inbound).input.threadParentId).toBe("message-1");
  });

  test("posts a reply at the top level when the parent is unknown to us", async () => {
    const inbound = await normalizeSlackEvent(
      delivery({ thread_ts: "1787100000.000001", ts: "1787200000.000200" }),
      ports()
    );

    expect(published(inbound).input.threadParentId).toBeUndefined();
  });

  test("accepts a direct message to the bot", async () => {
    const inbound = await normalizeSlackEvent(
      delivery({
        channel: IM_CHANNEL,
        channel_type: "im",
        text: "you around?",
      }),
      ports({
        found: {
          agentName: "Chief of Staff",
          bridge: bridge({
            channelId: "dm-channel",
            externalChannelId: IM_CHANNEL,
          }),
        },
      })
    );

    expect(published(inbound).input.channelId).toBe("dm-channel");
    expect(published(inbound).input.body).toBe("you around?");
  });

  test("ignores the bot's own posts - the echo-loop guard", async () => {
    const asBotMessage = await normalizeSlackEvent(
      delivery({
        bot_id: "B0AGENTUM",
        subtype: "bot_message",
        user: undefined,
      }),
      ports()
    );
    const asBotUser = await normalizeSlackEvent(
      delivery({ bot_id: "B0AGENTUM" }),
      ports()
    );

    expect(asBotMessage).toBeNull();
    expect(asBotUser).toBeNull();
  });

  test("ignores an unbridged Slack channel", async () => {
    expect(
      await normalizeSlackEvent(delivery({}), ports({ found: null }))
    ).toBeNull();
  });

  test("ignores a disabled bridge", async () => {
    const inbound = await normalizeSlackEvent(
      delivery({}),
      ports({
        found: { agentName: null, bridge: bridge({ status: "disabled" }) },
      })
    );

    expect(inbound).toBeNull();
  });

  test("ignores the second delivery of one Slack message", async () => {
    // Subscribing to both `message` and `app_mention` delivers a mentioning
    // message twice, under different event ids - so identity is channel:ts.
    const inbound = await normalizeSlackEvent(
      delivery({ type: "app_mention" }, { event_id: "Ev0002" }),
      ports({ duplicates: [`${SLACK_CHANNEL}:1787200000.000100`] })
    );

    expect(inbound).toBeNull();
  });

  test("attaches Slack files that downloaded, and drops the ones that did not", async () => {
    const inbound = await normalizeSlackEvent(
      delivery({
        files: [
          {
            id: "F0GOOD",
            mimetype: "application/pdf",
            name: "report.pdf",
            url_private: "https://files.slack.com/report.pdf",
          },
          {
            id: "F0GONE",
            mimetype: "image/png",
            name: "chart.png",
            url_private: "https://files.slack.com/chart.png",
          },
        ],
        text: "here it is",
      }),
      ports({ files: { F0GONE: null, F0GOOD: "attachment-1" } })
    );

    expect(published(inbound).input.attachmentIds).toEqual(["attachment-1"]);
  });

  test("ignores a message with neither text nor a usable file", async () => {
    expect(
      await normalizeSlackEvent(delivery({ text: "" }), ports())
    ).toBeNull();
  });
});
