import type { Db } from "#/db/client";
import { getAgentsByIds } from "#/modules/agents/service";
import {
  getChannelUnscoped,
  listChannelMembers,
  type MessageView,
} from "#/modules/messaging/service";
import { routerStub } from "./agent-router";
import type { MessageNotification } from "./wake-decision";

/**
 * The seam between "a message exists" and "somebody might need to wake up".
 * Called from `publishMessage`, so the web API, the MCP tools and (later) the
 * connectors all reach the router by the same path.
 */

/** Humans have no directory yet, matching how the MCP tools name them. */
const HUMAN_NAME = "User";
const EXTERNAL_NAME = "Someone outside the workspace";

export const buildNotification = async (
  db: Db,
  message: MessageView
): Promise<MessageNotification | null> => {
  // Unscoped: the message has already been written, and its channel is what
  // names the workspace rather than something to be checked against one.
  const channel = await getChannelUnscoped(db, message.channelId);
  if (!channel) {
    return null;
  }

  const members = await listChannelMembers(
    db,
    channel.workspaceId,
    message.channelId
  );
  const memberAgentIds = members
    .filter((member) => member.memberType === "agent")
    .map((member) => member.memberId);
  if (memberAgentIds.length === 0) {
    return null;
  }

  let authorName = HUMAN_NAME;
  if (message.authorType === "agent") {
    const [author] = await getAgentsByIds(db, [message.authorId]);
    authorName = author?.name ?? "A deleted agent";
  } else if (message.authorType === "external") {
    authorName = EXTERNAL_NAME;
  }

  return {
    authorId: message.authorId,
    authorName,
    authorType: message.authorType,
    body: message.body,
    channelId: message.channelId,
    channelKind: channel.kind,
    channelName: channel.name,
    createdAt: message.createdAt,
    memberAgentIds,
    mentionedAgentIds: message.mentions.map((mention) => mention.agentId),
    messageId: message.id,
    threadParentId: message.threadParentId,
  };
};

/**
 * Fire-and-forget from the caller's point of view: the router persists the
 * decision and returns, doing the Anthropic work on its own alarm. Failures are
 * swallowed - a router that is down must not stop a message being posted.
 */
export const notifyRouter = async (
  db: Db,
  env: Env,
  message: MessageView
): Promise<void> => {
  try {
    const notification = await buildNotification(db, message);
    if (!notification) {
      return;
    }
    await routerStub(env).notifyMessage(notification);
  } catch {
    // The message is already stored and broadcast; waking is best-effort.
  }
};
