import { type Context, Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import {
  badRequest,
  notFound,
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
import { slackClientForApp } from "./slack/adapter";
import {
  createDraftSlackApp,
  deleteSlackApp,
  getSlackAppForAgent,
  getSlackAppInWorkspace,
  listSlackApps,
  SlackAppExistsError,
  storeSlackAppTokens,
  toSlackAppView,
} from "./slack/apps";
import { SLACK_CONNECTOR } from "./slack/config";
import { isSlackChannelId } from "./slack/events";
import { buildSlackManifest, slackEventsUrl } from "./slack/manifest";

/**
 * Bridge management, mounted alongside the messaging module's channel router so
 * the URL reads `/api/channels/:id/bridge` without either module reaching into
 * the other, plus the Slack connection wizard's API on `/api/agents/:id/slack-app`.
 * Clerk-authed: this is the human's configuration surface.
 */

const CONFLICT = 409;
const UNPROCESSABLE = 422;
const TOKEN_MAX_LENGTH = 500;

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

  // The workspace's connected agents come with the bridge: bridging a channel
  // is choosing one of them, and with none connected there is nothing to choose.
  return c.json({
    bridge:
      (await getBridge(db, workspaceId, channelId, SLACK_CONNECTOR)) ?? null,
    slackApps: (await listSlackApps(db, workspaceId)).map(toSlackAppView),
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

  // The bridge speaks through one connected agent's Slack app, and the agent it
  // wakes is that app's agent - there is no separate choice to make.
  const app = await getSlackAppInWorkspace(
    db,
    channel.workspaceId,
    requireString(body, "slackAppId")
  );
  if (!app) {
    throw notFound("Slack app not found.");
  }
  const client = await slackClientForApp(c.env, app);
  if (!client) {
    throw badRequest(
      "That agent is not connected to Slack yet. Finish its Slack setup first."
    );
  }

  const info = await client.conversationsInfo(externalChannelId);
  if (!info) {
    throw badRequest(
      "Slack does not know that channel, or the bot cannot see it. Invite the bot to the channel and try again."
    );
  }
  if (!info.isMember) {
    await client.conversationsJoin(externalChannelId);
  }

  const bridge = await upsertBridge(db, channel.workspaceId, {
    agentId: app.agentId,
    channelId,
    connector: SLACK_CONNECTOR,
    externalChannelId,
    slackAppId: app.id,
  });

  return c.json({ bridge, channelName: info.name }, 201);
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

/** Surface-level reads: "which surfaces reach this agent". */
export const bridgesRoutes = new Hono<ApiEnv>();

bridgesRoutes.use("/bridges", requireAuth);

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

  const app = await getSlackAppForAgent(db, workspaceId, agentId);
  return c.json({
    bridges: await listBridgesForAgent(db, workspaceId, agentId),
    slackApp: app ? toSlackAppView(app) : null,
  });
});

// --- the connection wizard --------------------------------------------------

/**
 * `/api/agents/:id/slack-app`, mounted on the agents path the way the computer
 * and browser routers are: the connection reads as part of the agent, and it is
 * the agent that owns it.
 *
 * Tokens only ever travel inbound, through the PUT. No response here returns
 * one, masked or otherwise - `toSlackAppView` is the only serialization.
 */
export const agentSlackAppRoutes = new Hono<ApiEnv>();

agentSlackAppRoutes.use("*", requireAuth);

const requireAgent = async (c: Context<ApiEnv>, agentId: string) => {
  const agent = await getAgentById(
    createDb(c.env.DB),
    c.get("workspace").id,
    agentId
  );
  if (!agent) {
    throw notFound("Agent not found.");
  }
  return agent;
};

const requireKey = (c: Context<ApiEnv>): string => {
  const key = c.env.CONNECTOR_KEY;
  if (!key) {
    throw badRequest(
      "CONNECTOR_KEY is not configured, so Slack credentials cannot be stored."
    );
  }
  return key;
};

agentSlackAppRoutes.post("/:id/slack-app", async (c) => {
  const db = createDb(c.env.DB);
  const agent = await requireAgent(c, c.req.param("id"));

  let app: Awaited<ReturnType<typeof createDraftSlackApp>>;
  try {
    app = await createDraftSlackApp(db, c.get("workspace").id, agent.id);
  } catch (error) {
    if (error instanceof SlackAppExistsError) {
      return c.json({ error: error.message }, CONFLICT);
    }
    throw error;
  }

  const requestUrl = slackEventsUrl(c.env.PUBLIC_APP_URL, c.req.url, app.id);
  return c.json(
    {
      manifest: buildSlackManifest(agent, requestUrl),
      requestUrl,
      slackApp: toSlackAppView(app),
    },
    201
  );
});

/** `slackApp: null` when the agent has none - the wizard's step-one state. */
agentSlackAppRoutes.get("/:id/slack-app", async (c) => {
  const db = createDb(c.env.DB);
  const agent = await requireAgent(c, c.req.param("id"));
  const app = await getSlackAppForAgent(db, c.get("workspace").id, agent.id);
  if (!app) {
    return c.json({ slackApp: null });
  }

  // The manifest comes back with the row, not just on creation: the wizard is
  // resumable, and an app whose scopes need re-applying is pasted again.
  const requestUrl = slackEventsUrl(c.env.PUBLIC_APP_URL, c.req.url, app.id);
  return c.json({
    manifest: buildSlackManifest(agent, requestUrl),
    requestUrl,
    slackApp: toSlackAppView(app),
  });
});

/**
 * Step 2, and the retry after a failure: accepted from any status, since a
 * wrong paste leaves the row in `error` and the fix is another paste.
 */
agentSlackAppRoutes.put("/:id/slack-app/tokens", async (c) => {
  const db = createDb(c.env.DB);
  const agent = await requireAgent(c, c.req.param("id"));
  const app = await getSlackAppForAgent(db, c.get("workspace").id, agent.id);
  if (!app) {
    throw notFound("This agent is not connected to Slack.");
  }

  const body = await readJsonObject(c.req.raw);
  const result = await storeSlackAppTokens(db, requireKey(c), app, {
    botToken: requireString(body, "botToken", {
      maxLength: TOKEN_MAX_LENGTH,
    }),
    signingSecret: requireString(body, "signingSecret", {
      maxLength: TOKEN_MAX_LENGTH,
    }),
  });

  if (!result.ok) {
    // Slack's own error string, which is what makes the failure actionable
    // ("invalid_auth" for a mistyped token, "account_inactive" for a
    // deactivated app).
    return c.json(
      { error: result.error, slackApp: toSlackAppView(result.app) },
      UNPROCESSABLE
    );
  }
  return c.json({ slackApp: toSlackAppView(result.app) });
});

agentSlackAppRoutes.delete("/:id/slack-app", async (c) => {
  const db = createDb(c.env.DB);
  const agent = await requireAgent(c, c.req.param("id"));
  const app = await getSlackAppForAgent(db, c.get("workspace").id, agent.id);
  if (!app) {
    throw notFound("This agent is not connected to Slack.");
  }

  // The app's bridges go with it: they have no other way to reach Slack.
  await deleteSlackApp(db, app);
  return c.body(null, 204);
});
