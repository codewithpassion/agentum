import { Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import {
  badRequest,
  notFound,
  optionalString,
  readJsonObject,
  requireString,
} from "#/api/validation";
import { createDb } from "#/db/client";
import { getAgentById } from "#/modules/agents/service";
import { getChannel } from "#/modules/messaging/service";
import {
  deleteBridge,
  getBridge,
  listBridgesForAgent,
  upsertBridge,
} from "./bridges";
import { slackClientFor } from "./slack/adapter";
import { SLACK_CONNECTOR, slackConnectorStatus } from "./slack/config";
import { isSlackChannelId } from "./slack/events";

/**
 * Bridge management, mounted alongside the messaging module's channel router so
 * the URL reads `/api/channels/:id/bridge` without either module reaching into
 * the other. Clerk-authed: this is the human's configuration surface.
 */

export const bridgeRoutes = new Hono<ApiEnv>();

bridgeRoutes.use("*", requireAuth);

const requireChannel = async (
  db: ReturnType<typeof createDb>,
  channelId: string
) => {
  const channel = await getChannel(db, channelId);
  if (!channel) {
    throw notFound("Channel not found.");
  }
  return channel;
};

bridgeRoutes.get("/:id/bridge", async (c) => {
  const db = createDb(c.env.DB);
  const channelId = c.req.param("id");
  await requireChannel(db, channelId);

  return c.json({
    bridge: (await getBridge(db, channelId, SLACK_CONNECTOR)) ?? null,
    connector: slackConnectorStatus(c.env),
  });
});

bridgeRoutes.post("/:id/bridge", async (c) => {
  const db = createDb(c.env.DB);
  const channelId = c.req.param("id");
  await requireChannel(db, channelId);

  const body = await readJsonObject(c.req.raw);
  const externalChannelId = requireString(body, "externalChannelId");
  if (!isSlackChannelId(externalChannelId)) {
    throw badRequest(
      'That is not a Slack channel id. Copy it from the channel\'s "About" tab - it looks like C0123ABCDEF.'
    );
  }

  const agentId = optionalString(body, "agentId") || null;
  if (agentId && !(await getAgentById(db, agentId))) {
    throw notFound("Agent not found.");
  }

  // With a bot token we can tell "wrong id" from "bot not invited" before the
  // bridge exists; without one the bridge is still recorded, and inbound events
  // simply never arrive until the token is set.
  const client = slackClientFor(c.env);
  let channelName: string | null = null;
  if (client) {
    const info = await client.conversationsInfo(externalChannelId);
    if (!info) {
      throw badRequest(
        "Slack does not know that channel, or the bot cannot see it. Invite the bot to the channel and try again."
      );
    }
    channelName = info.name;
    if (!info.isMember) {
      await client.conversationsJoin(externalChannelId);
    }
  }

  const bridge = await upsertBridge(db, {
    agentId,
    channelId,
    connector: SLACK_CONNECTOR,
    externalChannelId,
  });

  return c.json({ bridge, channelName }, 201);
});

bridgeRoutes.delete("/:id/bridge", async (c) => {
  const db = createDb(c.env.DB);
  const deleted = await deleteBridge(db, c.req.param("id"), SLACK_CONNECTOR);
  if (!deleted) {
    throw notFound("This channel is not bridged.");
  }
  return c.body(null, 204);
});

/** Connector-level reads: status, and "which surfaces reach this agent". */
export const connectorsRoutes = new Hono<ApiEnv>();

connectorsRoutes.use("/bridges", requireAuth);
connectorsRoutes.use("/status", requireAuth);

connectorsRoutes.get("/status", (c) =>
  c.json({ connectors: [slackConnectorStatus(c.env)] })
);

connectorsRoutes.get("/bridges", async (c) => {
  const agentId = c.req.query("agentId");
  if (!agentId) {
    throw badRequest('"agentId" is required.');
  }
  const bridges = await listBridgesForAgent(createDb(c.env.DB), agentId);
  return c.json({ bridges, connector: slackConnectorStatus(c.env) });
});
