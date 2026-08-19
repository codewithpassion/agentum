import type { AuthorType, ChannelKind } from "#/modules/messaging/service";

/**
 * Who a message wakes, and how urgently. Pure: everything the decision needs is
 * resolved by the caller and passed in, so the rules can be tested without a
 * database, a Durable Object, or the Anthropic API.
 */

export interface MessageNotification {
  authorId: string;
  authorName: string;
  authorType: AuthorType;
  body: string;
  channelId: string;
  channelKind: ChannelKind;
  channelName: string;
  createdAt: number;
  /** Agent ids that are members of the channel. */
  memberAgentIds: string[];
  /** Agent ids the message @mentions, as resolved when it was stored. */
  mentionedAgentIds: string[];
  messageId: string;
  threadParentId: string | null;
}

export type WakeKind = "immediate" | "digest";

export interface WakeTarget {
  agentId: string;
  kind: WakeKind;
}

/**
 * The hybrid wake from the plan: a mention or a DM reaches the agent now,
 * everything else in a channel it belongs to reaches it in the next digest.
 *
 * An agent never wakes on its own message, and a mention of an agent that is
 * not in the channel is ignored - it could not read or answer there anyway.
 */
export const decideWakes = (
  notification: MessageNotification
): WakeTarget[] => {
  const members = new Set(notification.memberAgentIds);
  const authoredByAgent = notification.authorType === "agent";
  const mentioned = new Set(
    notification.mentionedAgentIds.filter((id) => members.has(id))
  );

  const targets: WakeTarget[] = [];
  for (const agentId of notification.memberAgentIds) {
    if (authoredByAgent && agentId === notification.authorId) {
      continue;
    }
    const immediate =
      mentioned.has(agentId) || notification.channelKind === "dm";
    targets.push({ agentId, kind: immediate ? "immediate" : "digest" });
  }

  return targets;
};
