import type { SlackEventCallback } from "./events";

/**
 * Inviting the bot to a Slack channel is the whole setup.
 *
 * Adding the bot in Slack used to be half a connection: it made the events
 * arrive, but nothing mapped them to a channel here, so they were received and
 * dropped. This is the other half - the channel, the agent's membership of it,
 * and the bridge - made from the one event that says the bot was let in.
 *
 * Every lookup is a port, for the same reason `normalize.ts` has them: what
 * gets provisioned, and what is refused, is decided here and tested without a
 * database or a Slack workspace.
 */

export const SLACK_JOINED_EVENT = "member_joined_channel";

export type ProvisionOutcome =
  | "bridged"
  | "duplicate"
  | "ignored"
  | "unknown-channel";

export interface SlackProvisionPorts {
  /** Adds the app's agent, without which a mention would wake nobody. */
  addAgentMember: (channelId: string) => Promise<void>;
  /** False when this delivery was already handled. */
  claim: (key: string) => Promise<boolean>;
  createBridge: (input: {
    channelId: string;
    externalChannelId: string;
  }) => Promise<void>;
  /** The new channel's id. Named after the Slack channel it mirrors. */
  createChannel: (name: string) => Promise<{ id: string }>;
  /** True when this Slack channel already reaches a channel here. */
  isBridged: (externalChannelId: string) => Promise<boolean>;
  /** `null` when Slack will not show us the channel. */
  readChannel: (externalChannelId: string) => Promise<{ name: string } | null>;
}

export const provisionSlackChannel = async (
  payload: SlackEventCallback,
  botUserId: string | null,
  ports: SlackProvisionPorts
): Promise<ProvisionOutcome> => {
  const { event } = payload;
  if (event.type !== SLACK_JOINED_EVENT || !event.channel) {
    return "ignored";
  }

  // The event fires for *everyone* who joins a channel the bot is already in,
  // so this comparison is what separates "the bot was invited" from "a
  // colleague wandered in". Without a bot user id we cannot tell the two apart,
  // and provisioning on the wrong one would make a channel per person.
  if (!botUserId || event.user !== botUserId) {
    return "ignored";
  }

  if (!(await ports.claim(payload.event_id))) {
    return "duplicate";
  }

  // Checked, not left to the insert: `upsertBridge` replaces the bridge for a
  // Slack channel, so a re-invite would quietly move an existing conversation
  // to a brand-new empty channel.
  if (await ports.isBridged(event.channel)) {
    return "duplicate";
  }

  const info = await ports.readChannel(event.channel);
  if (!info) {
    return "unknown-channel";
  }

  const channel = await ports.createChannel(info.name);
  // Before the bridge, deliberately. A channel that is bridged but has no agent
  // in it receives messages and wakes nobody, which is the failure this whole
  // feature exists to stop happening silently.
  await ports.addAgentMember(channel.id);
  await ports.createBridge({
    channelId: channel.id,
    externalChannelId: event.channel,
  });
  return "bridged";
};
