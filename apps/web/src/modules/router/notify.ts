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

const EXTERNAL_NAME = "Someone outside the workspace";
/**
 * A human with no surviving membership. `MessageView.author` already resolves
 * to "Former member" in that case, so this is only the belt-and-braces branch
 * for a view built without one.
 */
const UNKNOWN_HUMAN_NAME = "A former member";

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

  // The teammate an agent is about to be woken by, named: the person's own
  // name (resolved through `workspace_members` when the view was built), not
  // the generic "User" agents used to be told about.
  let authorName = message.author ? message.author.name : UNKNOWN_HUMAN_NAME;
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
    workspaceId: channel.workspaceId,
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
    // One router per workspace: a message in A can never reach B's instance,
    // whatever it says.
    await routerStub(env, notification.workspaceId).notifyMessage(notification);
  } catch {
    // The message is already stored and broadcast; waking is best-effort.
  }
};
