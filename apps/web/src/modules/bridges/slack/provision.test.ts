import { describe, expect, test } from "bun:test";
import type { SlackEventCallback } from "./events";
import {
  provisionSlackChannel,
  SLACK_JOINED_EVENT,
  type SlackProvisionPorts,
} from "./provision";

const SLACK_CHANNEL = "C0OPSCHAN";
const BOT = "U0BOTAGENT";

const joined = (
  overrides: { channel?: string; eventId?: string; user?: string } = {}
): SlackEventCallback => ({
  authorizations: [{ user_id: BOT }],
  event: {
    channel: overrides.channel ?? SLACK_CHANNEL,
    channel_type: "C",
    type: SLACK_JOINED_EVENT,
    user: overrides.user ?? BOT,
  },
  event_id: overrides.eventId ?? "Ev0001",
  team_id: "T0WORK",
  type: "event_callback",
});

const ports = (
  options: { bridged?: boolean; visible?: boolean } = {}
): SlackProvisionPorts & {
  bridges: { channelId: string; externalChannelId: string }[];
  created: string[];
  members: string[];
} => {
  const bridges: { channelId: string; externalChannelId: string }[] = [];
  const created: string[] = [];
  const members: string[] = [];
  const claimed = new Set<string>();

  return {
    addAgentMember: (channelId) => {
      members.push(channelId);
      return Promise.resolve();
    },
    bridges,
    claim: (key) => {
      if (claimed.has(key)) {
        return Promise.resolve(false);
      }
      claimed.add(key);
      return Promise.resolve(true);
    },
    createBridge: (input) => {
      bridges.push(input);
      return Promise.resolve();
    },
    createChannel: (name) => {
      created.push(name);
      return Promise.resolve({ id: `channel-${created.length}` });
    },
    created,
    isBridged: () => Promise.resolve(options.bridged ?? false),
    members,
    readChannel: () =>
      Promise.resolve(
        options.visible === false ? null : { name: "ops-standup" }
      ),
  };
};

describe("provisionSlackChannel", () => {
  test("makes the channel, the membership and the bridge", async () => {
    const slackPorts = ports();

    const outcome = await provisionSlackChannel(joined(), BOT, slackPorts);

    expect(outcome).toBe("bridged");
    expect(slackPorts.created).toEqual(["ops-standup"]);
    expect(slackPorts.members).toEqual(["channel-1"]);
    expect(slackPorts.bridges).toEqual([
      { channelId: "channel-1", externalChannelId: SLACK_CHANNEL },
    ]);
  });

  test("ignores everyone else who joins", async () => {
    const slackPorts = ports();

    // The bot sits in the channel, so it hears every later arrival too.
    const outcome = await provisionSlackChannel(
      joined({ user: "U1ALICE" }),
      BOT,
      slackPorts
    );

    expect(outcome).toBe("ignored");
    expect(slackPorts.created).toEqual([]);
  });

  test("ignores the event when the bot's own id is unknown", async () => {
    // Without it every joiner looks like the bot, and each would make a channel.
    const outcome = await provisionSlackChannel(joined(), null, ports());
    expect(outcome).toBe("ignored");
  });

  test("leaves an already bridged channel alone", async () => {
    const slackPorts = ports({ bridged: true });

    const outcome = await provisionSlackChannel(joined(), BOT, slackPorts);

    // Re-inviting the bot must not move the conversation to a new empty channel.
    expect(outcome).toBe("duplicate");
    expect(slackPorts.created).toEqual([]);
    expect(slackPorts.bridges).toEqual([]);
  });

  test("provisions once when Slack delivers the invite twice", async () => {
    const slackPorts = ports();

    const first = await provisionSlackChannel(joined(), BOT, slackPorts);
    const second = await provisionSlackChannel(joined(), BOT, slackPorts);

    expect([first, second]).toEqual(["bridged", "duplicate"]);
    expect(slackPorts.created).toHaveLength(1);
  });

  test("makes nothing when Slack will not show us the channel", async () => {
    const slackPorts = ports({ visible: false });

    const outcome = await provisionSlackChannel(joined(), BOT, slackPorts);

    expect(outcome).toBe("unknown-channel");
    expect(slackPorts.created).toEqual([]);
    expect(slackPorts.bridges).toEqual([]);
  });

  test("ignores an event that is not a join", async () => {
    const message = joined();
    message.event.type = "message";

    expect(await provisionSlackChannel(message, BOT, ports())).toBe("ignored");
  });
});
