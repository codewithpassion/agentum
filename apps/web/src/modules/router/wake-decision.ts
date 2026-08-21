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
  /**
   * Where the message came from - `slack` for a bridged one, `native`
   * otherwise. Implicit thread addressing is scoped to bridged surfaces: in
   * the web UI a thread reply is one click from a mention, and a Slack one is
   * not.
   */
  origin: string;
  threadParentId: string | null;
  /**
   * The channel's workspace. It travels with the notification because that is
   * the only way the router Durable Object can learn which tenant it is: it is
   * addressed by `idFromName(workspaceId)` and cannot read that name back.
   */
  workspaceId: string;
}

export type WakeKind = "consider" | "digest" | "immediate";

/** Where implicit thread addressing applies; see `addressing.ts`. */
const IMPLICIT_ORIGIN = "slack";

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

  // A thread reply on a bridged surface is the one case where not being
  // mentioned does not settle it. `consider` is not a third outcome - it is a
  // question the router asks before landing on immediate or digest.
  const implicit =
    notification.origin === IMPLICIT_ORIGIN &&
    notification.threadParentId !== null &&
    notification.channelKind !== "dm" &&
    notification.authorType !== "agent";

  const targets: WakeTarget[] = [];
  for (const agentId of notification.memberAgentIds) {
    if (authoredByAgent && agentId === notification.authorId) {
      continue;
    }
    if (mentioned.has(agentId) || notification.channelKind === "dm") {
      targets.push({ agentId, kind: "immediate" });
      continue;
    }
    targets.push({ agentId, kind: implicit ? "consider" : "digest" });
  }

  return targets;
};
