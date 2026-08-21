import type { WorkspaceRef } from "#/modules/messaging/service";
import type { ChannelBridge } from "../schema";
import type { InboundMessage } from "../types";
import { SLACK_CONNECTOR } from "./config";
import {
  type SlackEventCallback,
  type SlackFile,
  type SlackMessageEvent,
  slackMessageKey,
} from "./events";
import { collectUserMentions, slackTextToBody } from "./text";

/**
 * Inbound normalisation. Every lookup it needs is a port, so the decision logic
 * - which events we take, how a Slack thread becomes ours, what the body says -
 * is exercised in tests without a database or a Slack workspace.
 */

export interface InboundBridge {
  /** The agent the bot speaks as, resolved to its `@Name`. */
  agentName: string | null;
  bridge: ChannelBridge;
  /**
   * The bridge row's workspace. An inbound event carries no session, so this is
   * the only thing that says which tenant the message belongs to; null when the
   * workspace has since been deleted, in which case the event is dropped.
   */
  workspace: WorkspaceRef | null;
}

export interface SlackInboundPorts {
  /** `null` when the Slack channel is not bridged - we ignore it. */
  findBridge: (externalChannelId: string) => Promise<InboundBridge | null>;
  /** True when this `channel:ts` was already published. */
  isDuplicate: (externalId: string) => Promise<boolean>;
  /**
   * Files the author's Slack display name against the id the message stores
   * them under, so a reader sees a person rather than `slack:U0A…`.
   */
  rememberAuthor: (
    workspaceId: string,
    author: { authorId: string; displayName: string }
  ) => Promise<void>;
  /** Our message id for a Slack `channel:ts`, when we have seen the parent. */
  resolveThreadParent: (externalId: string) => Promise<string | null>;
  /** Slack user id → display name, cached by the caller. */
  resolveUserNames: (
    userIds: readonly string[]
  ) => Promise<Map<string, string>>;
  /** Attachment id, or `null` when the download failed - files are optional. */
  storeFile: (file: SlackFile) => Promise<string | null>;
}

/**
 * The echo-loop guard's first layer. Anything the bot itself posted comes back
 * carrying `bot_id`, and every `subtype` (edits, joins, `bot_message`) is a
 * message we do not republish.
 */
export const isPublishableEvent = (event: SlackMessageEvent): boolean => {
  if (event.type !== "message" && event.type !== "app_mention") {
    return false;
  }
  if (event.bot_id || event.subtype) {
    return false;
  }
  return Boolean(event.user && event.channel && event.ts);
};

export const botUserIdOf = (payload: SlackEventCallback): string | null =>
  payload.authorizations?.[0]?.user_id ?? null;

const storeFiles = async (
  files: readonly SlackFile[],
  ports: SlackInboundPorts
): Promise<string[]> => {
  const stored = await Promise.all(files.map((file) => ports.storeFile(file)));
  return stored.filter((id): id is string => id !== null);
};

export const normalizeSlackEvent = async (
  payload: SlackEventCallback,
  ports: SlackInboundPorts
): Promise<InboundMessage | null> => {
  const { event } = payload;
  if (!isPublishableEvent(event)) {
    return null;
  }

  const channel = event.channel ?? "";
  const ts = event.ts ?? "";
  const externalId = slackMessageKey(channel, ts);

  const found = await ports.findBridge(channel);
  if (found?.bridge.status !== "active" || !found.workspace) {
    return null;
  }

  // A channel message that mentions the bot is delivered twice - as `message`
  // and as `app_mention`, with different event ids - so identity is the message,
  // not the delivery.
  if (await ports.isDuplicate(externalId)) {
    return null;
  }

  const text = event.text ?? "";
  // The author is resolved alongside the people they mention, so the display
  // name cache is warm by the time anyone mentions them back.
  const userNames = await ports.resolveUserNames([
    ...new Set([...collectUserMentions(text), event.user ?? ""]),
  ]);
  const body = slackTextToBody(text, {
    agentName: found.agentName,
    botUserId: botUserIdOf(payload),
    userNames,
  });

  const attachmentIds = await storeFiles(event.files ?? [], ports);
  if (!body && attachmentIds.length === 0) {
    return null;
  }

  const authorId = `${SLACK_CONNECTOR}:${event.user ?? ""}`;
  // Recorded on every message, not just the first: a Slack display name is
  // theirs to change, and the newest one a message arrived under is the one
  // worth keeping.
  const displayName = userNames.get(event.user ?? "");
  if (displayName) {
    await ports.rememberAuthor(found.workspace.id, { authorId, displayName });
  }

  // A reply whose parent we never saw is posted at the top level rather than
  // dropped: the conversation stays visible, it just loses the nesting.
  const threadParentId =
    event.thread_ts && event.thread_ts !== ts
      ? await ports.resolveThreadParent(
          slackMessageKey(channel, event.thread_ts)
        )
      : null;

  return {
    externalId,
    input: {
      attachmentIds,
      authorId,
      authorType: "external",
      body,
      channelId: found.bridge.channelId,
      origin: SLACK_CONNECTOR,
      workspace: found.workspace,
      ...(threadParentId ? { threadParentId } : {}),
    },
  };
};
