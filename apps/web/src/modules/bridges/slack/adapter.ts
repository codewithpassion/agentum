import type { Db } from "#/db/client";
import { getAgentById } from "#/modules/agents/service";
import { MAX_ATTACHMENT_BYTES } from "#/modules/messaging/attachment-rules";
import {
  getAttachment,
  storeAttachment,
} from "#/modules/messaging/attachment-service";
import type { MessageView } from "#/modules/messaging/service";
import { findBridgeByExternalChannel } from "../bridges";
import { findExternalId, findInternalId } from "../refs";
import type { ChannelBridge } from "../schema";
import type { BridgeAdapter, ExternalRefInput, InboundMessage } from "../types";
import { createSlackClient, type SlackClient } from "./client";
import { readSlackConfig, SLACK_CONNECTOR, SLACK_LABEL } from "./config";
import type { SlackEventCallback, SlackFile } from "./events";
import { mirrorSlackMessage, type SlackOutboundPorts } from "./mirror";
import { normalizeSlackEvent, type SlackInboundPorts } from "./normalize";
import { resolveSlackUserNames } from "./users";

/**
 * The Slack adapter: the ports declared by `normalize` and `mirror` bound to
 * D1, R2 and the Slack Web API. Everything here is I/O; the decisions live in
 * the two pure-by-injection modules it wires together.
 */

const agentName = async (
  db: Db,
  agentId: string | null
): Promise<string | null> => {
  if (!agentId) {
    return null;
  }
  const agent = await getAgentById(db, agentId);
  return agent?.name ?? null;
};

const downloadSlackFile = async (
  db: Db,
  env: Env,
  client: SlackClient | null,
  file: SlackFile
): Promise<string | null> => {
  if (!(client && file.url_private && file.name)) {
    return null;
  }
  // Checked before the download, not after: `storeAttachment` would reject the
  // file anyway, but only once the whole thing sat in the isolate's memory.
  if (file.size !== undefined && file.size > MAX_ATTACHMENT_BYTES) {
    return null;
  }
  const data = await client.downloadFile(file.url_private);
  if (!data) {
    return null;
  }
  const result = await storeAttachment(
    db,
    env.ATTACHMENTS,
    new File([data], file.name, {
      type: file.mimetype ?? "application/octet-stream",
    })
  );
  return result.ok ? result.attachment.id : null;
};

const inboundPorts = (
  db: Db,
  env: Env,
  client: SlackClient | null
): SlackInboundPorts => ({
  async findBridge(externalChannelId) {
    const bridge = await findBridgeByExternalChannel(
      db,
      SLACK_CONNECTOR,
      externalChannelId
    );
    if (!bridge) {
      return null;
    }
    return { agentName: await agentName(db, bridge.agentId), bridge };
  },

  async isDuplicate(externalId) {
    const existing = await findInternalId(
      db,
      SLACK_CONNECTOR,
      "message",
      externalId
    );
    return existing !== undefined;
  },

  async resolveThreadParent(externalId) {
    const parent = await findInternalId(
      db,
      SLACK_CONNECTOR,
      "message",
      externalId
    );
    return parent ?? null;
  },

  resolveUserNames: (userIds) => resolveSlackUserNames(db, client, userIds),

  // A file we cannot fetch is dropped in silence: the message it belongs to is
  // worth more than the attachment.
  storeFile: (file) => downloadSlackFile(db, env, client, file),
});

const outboundPorts = (db: Db, env: Env): SlackOutboundPorts => ({
  authorName: (message: MessageView) =>
    message.authorType === "agent"
      ? agentName(db, message.authorId)
      : Promise.resolve(null),

  async readAttachment(attachmentId) {
    const attachment = await getAttachment(db, attachmentId);
    if (!attachment) {
      return null;
    }
    const object = await env.ATTACHMENTS.get(attachment.r2Key);
    if (!object) {
      return null;
    }
    return { data: await object.arrayBuffer(), filename: attachment.filename };
  },

  async resolveParentKey(internalMessageId) {
    const key = await findExternalId(
      db,
      SLACK_CONNECTOR,
      "message",
      internalMessageId
    );
    return key ?? null;
  },
});

export const createSlackAdapter = (
  db: Db,
  env: Env
): BridgeAdapter<SlackEventCallback> => {
  const config = readSlackConfig(env);
  const client = config ? createSlackClient(config.botToken) : null;

  return {
    connector: SLACK_CONNECTOR,
    label: SLACK_LABEL,

    mirrorOutbound: (
      message: MessageView,
      bridge: ChannelBridge
    ): Promise<ExternalRefInput | null> =>
      client
        ? mirrorSlackMessage(message, bridge, client, outboundPorts(db, env))
        : Promise.resolve(null),

    normalizeInbound: (event): Promise<InboundMessage | null> =>
      normalizeSlackEvent(event, inboundPorts(db, env, client)),
  };
};

/** The Slack client for the management API (`conversations.info`/`join`). */
export const slackClientFor = (env: Env): SlackClient | null => {
  const config = readSlackConfig(env);
  return config ? createSlackClient(config.botToken) : null;
};
