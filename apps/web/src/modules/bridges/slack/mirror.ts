import type { MessageView } from "#/modules/messaging/service";
import type { QuestionView } from "#/modules/questions/view";
import type { ChannelBridge } from "../schema";
import type { ExternalRefInput } from "../types";
import {
  questionBlocks,
  questionFallbackText,
  resolvedQuestionBlocks,
} from "./blocks";
import type { SlackClient, SlackPostMessageInput } from "./client";
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
  /**
   * Deep link to a question card in the web app, for the one thing Slack cannot
   * do in a message: type a free-text answer. Resolved lazily - only a question
   * without options ever asks for it.
   */
  webLink: (question: QuestionView) => Promise<string | null>;
}

/**
 * A question is mirrored as a card rather than as its text: Block Kit buttons
 * are the whole point of asking in Slack. Every other message is text, exactly
 * as before.
 */
const questionPayload = async (
  question: QuestionView,
  ports: SlackOutboundPorts
): Promise<Pick<SlackPostMessageInput, "blocks" | "text">> => {
  const link = question.options ? null : await ports.webLink(question);
  return {
    blocks: questionBlocks(question, { link }),
    text: questionFallbackText(question),
  };
};

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

  const content = message.question
    ? await questionPayload(message.question, ports)
    : { text: mirroredText(message.body, await ports.authorName(message)) };

  const posted = await client.postMessage({
    channel: bridge.externalChannelId,
    ...content,
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

/**
 * The other half of the two-way card: a question resolved anywhere - a web
 * click, the expiry sweep - rewrites the mirrored Slack card so its buttons
 * cannot be pressed for an answer that is already in.
 *
 * `messageKey` is the question card's `channel:ts` from `external_refs`, which
 * exists because the card was mirrored like any other message. Without one the
 * question was never in Slack and there is nothing to update.
 */
export const mirrorQuestionResolution = async (
  question: QuestionView,
  bridge: ChannelBridge,
  client: SlackClient,
  messageKey: string
): Promise<boolean> => {
  if (bridge.status !== "active") {
    return false;
  }
  return await client.chatUpdate({
    blocks: resolvedQuestionBlocks(question),
    channel: bridge.externalChannelId,
    text: questionFallbackText(question),
    ts: slackMessageTs(messageKey),
  });
};
