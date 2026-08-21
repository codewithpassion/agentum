import type { Db } from "#/db/client";
import { getAgentByIdUnscoped } from "#/modules/agents/service";
import { MAX_ATTACHMENT_BYTES } from "#/modules/messaging/attachment-rules";
import {
  getAttachment,
  storeAttachment,
} from "#/modules/messaging/attachment-service";
import {
  linkExternalAuthor,
  rememberExternalAuthor,
} from "#/modules/messaging/external-authors";
import type { MessageView } from "#/modules/messaging/service";
import {
  findMemberByEmail,
  getWorkspaceById,
} from "#/modules/workspaces/service";
import { findBridgeByExternalChannel } from "../bridges";
import { findExternalId, findInternalId } from "../refs";
import type { ChannelBridge, SlackApp } from "../schema";
import { takeThinkingPlaceholder } from "../thinking";
import type { BridgeAdapter, ExternalRefInput, InboundMessage } from "../types";
import { slackAppCredentials } from "./apps";
import { questionWebLink } from "./blocks";
import { createSlackClient, type SlackClient } from "./client";
import { SLACK_CONNECTOR, SLACK_LABEL } from "./config";
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
  // Unscoped on purpose: the bridge row is what set the tenancy here, and the
  // agent it names was written into it from inside that workspace.
  const agent = await getAgentByIdUnscoped(db, agentId);
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

/**
 * Filing who wrote a bridged message, and - the first time we ever see them -
 * having one go at working out which workspace member that is.
 *
 * The match is on the Slack profile email, which needs `users:read.email`; an
 * app installed before that scope was asked for gets no email, no link, and the
 * person is named but unlinked until somebody says who they are. Attempted once
 * per person rather than per message, and `auto` never overwrites a correction
 * somebody made by hand.
 */
const rememberSlackAuthor = async (
  db: Db,
  client: SlackClient,
  workspaceId: string,
  author: { authorId: string; displayName: string }
): Promise<void> => {
  const { firstSighting } = await rememberExternalAuthor(
    db,
    workspaceId,
    author
  );
  if (!firstSighting) {
    return;
  }

  const slackUserId = author.authorId.slice(SLACK_CONNECTOR.length + 1);
  const profile = await client.usersInfo(slackUserId);
  if (!profile?.email) {
    return;
  }

  const member = await findMemberByEmail(db, workspaceId, profile.email);
  if (!member) {
    return;
  }
  await linkExternalAuthor(db, workspaceId, {
    authorId: author.authorId,
    linkSource: "auto",
    memberId: member.id,
  });
};

const inboundPorts = (
  db: Db,
  env: Env,
  app: SlackApp,
  client: SlackClient
): SlackInboundPorts => ({
  async findBridge(externalChannelId) {
    const bridge = await findBridgeByExternalChannel(
      db,
      SLACK_CONNECTOR,
      externalChannelId
    );
    // The ownership filter. Two connected bots in the same Slack channel both
    // receive its `message` events; only the app the bridge belongs to may act
    // on one, which is what keeps a message from being ingested twice.
    if (!bridge || bridge.slackAppId !== app.id) {
      return null;
    }
    const workspace = await getWorkspaceById(db, bridge.workspaceId);
    return {
      agentName: await agentName(db, bridge.agentId),
      bridge,
      workspace: workspace ? { id: workspace.id, slug: workspace.slug } : null,
    };
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

  rememberAuthor: (workspaceId, author) =>
    rememberSlackAuthor(db, client, workspaceId, author),

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

const outboundPorts = (
  db: Db,
  env: Env,
  app: SlackApp
): SlackOutboundPorts => ({
  // The app's own agent posts as the bot itself, so prefixing its name would
  // say it twice. Every other agent still needs one: they share this bot.
  authorName: (message: MessageView) => {
    if (message.authorType !== "agent" || message.authorId === app.agentId) {
      return Promise.resolve(null);
    }
    return agentName(db, message.authorId);
  },

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

  takeThinkingPlaceholder: (agentId, threadParentId) =>
    takeThinkingPlaceholder(db, agentId, threadParentId),

  // Only a free-text question asks for this, so the workspace lookup it costs
  // is not paid by the ordinary mirrored message.
  async webLink(question) {
    const workspace = await getWorkspaceById(db, app.workspaceId);
    return workspace
      ? questionWebLink(env.PUBLIC_APP_URL, workspace.slug, question)
      : null;
  },
});

/**
 * Everything the adapter does now happens as one particular Slack app: the
 * client speaks with that app's bot token, inbound events are filtered to the
 * bridges it owns, and outbound posts know which agent the bot *is*.
 */
export const createSlackAdapter = (
  db: Db,
  env: Env,
  app: SlackApp,
  client: SlackClient
): BridgeAdapter<SlackEventCallback> => ({
  connector: SLACK_CONNECTOR,
  label: SLACK_LABEL,

  mirrorOutbound: (
    message: MessageView,
    bridge: ChannelBridge
  ): Promise<ExternalRefInput | null> =>
    mirrorSlackMessage(message, bridge, client, outboundPorts(db, env, app)),

  normalizeInbound: (event): Promise<InboundMessage | null> =>
    normalizeSlackEvent(event, inboundPorts(db, env, app, client)),
});

/**
 * The Slack client that speaks as this app - for the events route, the mirror,
 * and the management calls (`conversations.info`/`join`). `null` while the app
 * is a draft, or when `CONNECTOR_KEY` is missing: either way it has no usable
 * token, so nothing may be sent in its name.
 */
export const slackClientForApp = async (
  env: Env,
  app: SlackApp
): Promise<SlackClient | null> => {
  const credentials = await slackAppCredentials(env.CONNECTOR_KEY || null, app);
  return credentials ? createSlackClient(credentials.botToken) : null;
};
