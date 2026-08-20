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
import { SLACK_CONNECTOR, slackSurfaceStatus } from "./slack/config";
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
  workspaceId: string,
  channelId: string
) => {
  const channel = await getChannel(db, workspaceId, channelId);
  if (!channel) {
    throw notFound("Channel not found.");
  }
  return channel;
};

bridgeRoutes.get("/:id/bridge", async (c) => {
  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const channelId = c.req.param("id");
  await requireChannel(db, workspaceId, channelId);

  return c.json({
    bridge:
      (await getBridge(db, workspaceId, channelId, SLACK_CONNECTOR)) ?? null,
    connector: slackSurfaceStatus(c.env),
  });
});

bridgeRoutes.post("/:id/bridge", async (c) => {
  const db = createDb(c.env.DB);
  const channelId = c.req.param("id");
  // A bridge belongs to the workspace of the channel it delivers into: that is
  // what maps an inbound Slack event, which carries no session, to a tenant.
  const channel = await requireChannel(db, c.get("workspace").id, channelId);

  const body = await readJsonObject(c.req.raw);
  const externalChannelId = requireString(body, "externalChannelId");
  if (!isSlackChannelId(externalChannelId)) {
    throw badRequest(
      'That is not a Slack channel id. Copy it from the channel\'s "About" tab - it looks like C0123ABCDEF.'
    );
  }

  const agentId = optionalString(body, "agentId") || null;
  if (agentId && !(await getAgentById(db, channel.workspaceId, agentId))) {
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

  const bridge = await upsertBridge(db, channel.workspaceId, {
    agentId,
    channelId,
    connector: SLACK_CONNECTOR,
    externalChannelId,
  });

  return c.json({ bridge, channelName }, 201);
});

bridgeRoutes.delete("/:id/bridge", async (c) => {
  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const channelId = c.req.param("id");
  // The channel is resolved first for the same reason the other two do it: a
  // bare channel id in the path must not reach another tenant's bridge.
  await requireChannel(db, workspaceId, channelId);

  const deleted = await deleteBridge(
    db,
    workspaceId,
    channelId,
    SLACK_CONNECTOR
  );
  if (!deleted) {
    throw notFound("This channel is not bridged.");
  }
  return c.body(null, 204);
});

/** Surface-level reads: status, and "which surfaces reach this agent". */
export const bridgesRoutes = new Hono<ApiEnv>();

bridgesRoutes.use("/bridges", requireAuth);
bridgesRoutes.use("/status", requireAuth);

bridgesRoutes.get("/status", (c) =>
  c.json({ connectors: [slackSurfaceStatus(c.env)] })
);

bridgesRoutes.get("/bridges", async (c) => {
  const agentId = c.req.query("agentId");
  if (!agentId) {
    throw badRequest('"agentId" is required.');
  }

  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;
  if (!(await getAgentById(db, workspaceId, agentId))) {
    throw notFound("Agent not found.");
  }

  const bridges = await listBridgesForAgent(db, workspaceId, agentId);
  return c.json({ bridges, connector: slackSurfaceStatus(c.env) });
});
