import type { MessageView } from "#/modules/messaging/service";
import type { ChannelBridge } from "../schema";
import type { ExternalRefInput } from "../types";
import type { SlackClient } from "./client";
import { SLACK_CONNECTOR } from "./config";
import { slackMessageKey, slackMessageTs } from "./events";
import { mirroredText } from "./text";

/** Outbound mirroring: a published message becomes a Slack post. */

export interface SlackOutboundPorts {
  /** Shown in Slack, since every mirrored post comes from the same bot. */
  authorName: (message: MessageView) => Promise<string | null>;
  /** Bytes for re-upload; `null` skips the file rather than the message. */
  readAttachment: (
    attachmentId: string
  ) => Promise<{ data: ArrayBuffer; filename: string } | null>;
  /** Our thread parent's Slack `channel:ts`, when it has one. */
  resolveParentKey: (internalMessageId: string) => Promise<string | null>;
}

const uploadAttachments = async (
  message: MessageView,
  bridge: ChannelBridge,
  client: SlackClient,
  ports: SlackOutboundPorts,
  threadTs: string
): Promise<void> => {
  for (const attachment of message.attachments) {
    // Sequential on purpose: files appear in Slack in the order they were
    // attached, and three uploads at once is three times the rate-limit cost.
    // biome-ignore lint/performance/noAwaitInLoops: ordered uploads are the point
    const file = await ports.readAttachment(attachment.id);
    if (!file) {
      continue;
    }
    await client.uploadFile({
      channel: bridge.externalChannelId,
      data: file.data,
      filename: file.filename,
      threadTs,
    });
  }
};

/**
 * The echo-loop guard: a message that came from Slack is never sent back to
 * Slack. Everything else in a bridged channel - the user's posts from our UI
 * and the agents' posts through MCP - is mirrored.
 */
export const mirrorSlackMessage = async (
  message: MessageView,
  bridge: ChannelBridge,
  client: SlackClient,
  ports: SlackOutboundPorts
): Promise<ExternalRefInput | null> => {
  if (message.origin === SLACK_CONNECTOR || bridge.status !== "active") {
    return null;
  }

  const parentKey = message.threadParentId
    ? await ports.resolveParentKey(message.threadParentId)
    : null;
  const threadTs = parentKey ? slackMessageTs(parentKey) : undefined;

  const posted = await client.postMessage({
    channel: bridge.externalChannelId,
    text: mirroredText(message.body, await ports.authorName(message)),
    ...(threadTs ? { threadTs } : {}),
  });
  if (!posted) {
    return null;
  }

  if (message.attachments.length > 0) {
    // Files follow the message into the same thread, so a reply's attachments
    // do not surface at the top of the channel.
    await uploadAttachments(
      message,
      bridge,
      client,
      ports,
      threadTs ?? posted.ts
    );
  }

  return {
    externalId: slackMessageKey(bridge.externalChannelId, posted.ts),
    internalId: message.id,
    internalType: "message",
  };
};
