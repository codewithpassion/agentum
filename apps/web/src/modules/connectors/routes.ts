import { type Context, Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import {
  badRequest,
  notFound,
  optionalBoolean,
  optionalString,
  readJsonObject,
  requireString,
} from "#/api/validation";
import { createDb } from "#/db/client";
import { isUniqueConstraintError } from "#/db/errors";
import { getAgentById, getAgentsByIds } from "#/modules/agents/service";
import { resyncPendingAgents } from "#/modules/anthropic/service";
import { createVaults } from "#/modules/anthropic/vaults";
import {
  addConnector,
  assignConnector,
  beginReauthorization,
  ConnectorCapError,
  type ConnectorContext,
  ConnectorFlowError,
  completeBearer,
  completeOAuthCallback,
  getConnector,
  listAgentIdsForConnector,
  listConnectors,
  listConnectorsForAgent,
  removeConnector,
  renameConnector,
  setConnectorDisabled,
  testConnection,
  toConnectorView,
  unassignConnector,
} from "./service";
import { InvalidConnectorUrlError } from "./url";

/**
 * The Connectors API. Two routers on one path, for the same reason the Slack
 * bridge splits: everything a human drives is Clerk-authed, while the OAuth
 * callback is a redirect from a third-party authorization server and carries
 * its own credential - the `state` we minted and stored.
 */

const CONFLICT = 409;
const NAME_MAX_LENGTH = 120;
const URL_MAX_LENGTH = 2048;
const TOKEN_MAX_LENGTH = 8192;
const TRAILING_SLASHES = /\/+$/;

export const CALLBACK_PATH = "/api/connectors/oauth/callback";

/** Must match byte for byte at the token endpoint, so it is built one way. */
export const callbackUrlFor = (
  publicAppUrl: string | undefined,
  requestUrl: string
): string => {
  const base = publicAppUrl || new URL(requestUrl).origin;
  return `${base.replace(TRAILING_SLASHES, "")}${CALLBACK_PATH}`;
};

const contextFor = (c: Context<ApiEnv>): ConnectorContext => ({
  db: createDb(c.env.DB),
  key: c.env.CONNECTOR_KEY || null,
  redirectUri: callbackUrlFor(c.env.PUBLIC_APP_URL, c.req.url),
  vaults: createVaults(c.env),
});

/** By bare id, and always within the workspace on the request context. */
const requireConnector = async (
  c: Context<ApiEnv>,
  ctx: ConnectorContext,
  id: string
) => {
  const connector = await getConnector(ctx.db, c.get("workspace").id, id);
  if (!connector) {
    throw notFound("Connector not found.");
  }
  return connector;
};

/** User-facing failures share one shape; anything else is a real 500. */
const asHttpError = (error: unknown): never => {
  if (
    error instanceof InvalidConnectorUrlError ||
    error instanceof ConnectorFlowError ||
    error instanceof ConnectorCapError
  ) {
    throw badRequest(error.message);
  }
  throw error;
};

/**
 * A connector change leaves every agent holding it with a stale `mcp_servers`
 * array. Paying that off means rotating the agent's MCP token and pushing the
 * whole array again, so it runs behind the response and only for agents with
 * no session - the rest are picked up by the router when theirs ends.
 */
const resyncAgents = (c: Context<ApiEnv>, ctx: ConnectorContext): void => {
  const work = resyncPendingAgents(ctx.db, c.env, c.req.url).catch(() => {
    // Every failure path records itself on the agent row.
  });
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No execution context (a direct fetch in a test): let it run detached.
  }
};

// --- the human-driven surface -----------------------------------------------

export const connectorsRoutes = new Hono<ApiEnv>();

connectorsRoutes.use("*", requireAuth);

connectorsRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const agentId = c.req.query("agentId");
  if (!agentId) {
    return c.json({
      connectors: (await listConnectors(db, workspaceId)).map(toConnectorView),
    });
  }

  // An agent's connectors are its own workspace's by construction; resolving
  // the agent scoped is what stops another tenant's id being asked about.
  if (!(await getAgentById(db, workspaceId, agentId))) {
    throw notFound("Agent not found.");
  }
  const rows = await listConnectorsForAgent(db, agentId);
  return c.json({ connectors: rows.map(toConnectorView) });
});

connectorsRoutes.post("/", async (c) => {
  const body = await readJsonObject(c.req.raw);
  const ctx = contextFor(c);

  try {
    const { connector, outcome } = await addConnector(
      ctx,
      c.get("workspace").id,
      {
        name: optionalString(body, "name", { maxLength: NAME_MAX_LENGTH }),
        url: requireString(body, "url", { maxLength: URL_MAX_LENGTH }),
      }
    );
    return c.json({ connector: toConnectorView(connector), outcome }, 201);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return c.json({ error: "That server is already a connector." }, CONFLICT);
    }
    return asHttpError(error);
  }
});

connectorsRoutes.get("/:id", async (c) => {
  const ctx = contextFor(c);
  const connector = await requireConnector(c, ctx, c.req.param("id"));
  const agentIds = await listAgentIdsForConnector(ctx.db, connector.id);
  const agents = await getAgentsByIds(ctx.db, agentIds);

  return c.json({
    agents: agents.map((agent) => ({
      avatar: agent.avatar,
      id: agent.id,
      name: agent.name,
    })),
    connector: toConnectorView(connector),
  });
});

connectorsRoutes.patch("/:id", async (c) => {
  const ctx = contextFor(c);
  const connector = await requireConnector(c, ctx, c.req.param("id"));
  const body = await readJsonObject(c.req.raw);

  const name = optionalString(body, "name", { maxLength: NAME_MAX_LENGTH });
  const renamed = name
    ? ((await renameConnector(ctx, connector.id, name)) ?? connector)
    : connector;

  const updated =
    "disabled" in body
      ? ((await setConnectorDisabled(
          ctx,
          renamed,
          optionalBoolean(body, "disabled")
        )) ?? renamed)
      : renamed;

  resyncAgents(c, ctx);
  return c.json({ connector: toConnectorView(updated) });
});

connectorsRoutes.delete("/:id", async (c) => {
  const ctx = contextFor(c);
  const connector = await requireConnector(c, ctx, c.req.param("id"));
  const { vaultError } = await removeConnector(ctx, connector);
  resyncAgents(c, ctx);
  return c.json({ removed: true, vaultError });
});

/** Rung 3's manual branch: the server has no dynamic client registration. */
connectorsRoutes.post("/:id/oauth/client", async (c) => {
  const ctx = contextFor(c);
  const connector = await requireConnector(c, ctx, c.req.param("id"));
  const body = await readJsonObject(c.req.raw);

  try {
    const outcome = await beginReauthorization(ctx, connector, {
      clientId: requireString(body, "clientId"),
      clientSecret: optionalString(body, "clientSecret") ?? null,
    });
    resyncAgents(c, ctx);
    return c.json({ outcome });
  } catch (error) {
    return asHttpError(error);
  }
});

connectorsRoutes.post("/:id/reauthorize", async (c) => {
  const ctx = contextFor(c);
  const connector = await requireConnector(c, ctx, c.req.param("id"));

  try {
    const outcome = await beginReauthorization(ctx, connector);
    resyncAgents(c, ctx);
    return c.json({ outcome });
  } catch (error) {
    return asHttpError(error);
  }
});

connectorsRoutes.post("/:id/bearer", async (c) => {
  const ctx = contextFor(c);
  const connector = await requireConnector(c, ctx, c.req.param("id"));
  const body = await readJsonObject(c.req.raw);

  try {
    const updated = await completeBearer(
      ctx,
      connector,
      requireString(body, "token", { maxLength: TOKEN_MAX_LENGTH })
    );
    resyncAgents(c, ctx);
    return c.json({ connector: toConnectorView(updated) });
  } catch (error) {
    return asHttpError(error);
  }
});

connectorsRoutes.post("/:id/test", async (c) => {
  const ctx = contextFor(c);
  const connector = await requireConnector(c, ctx, c.req.param("id"));
  const result = await testConnection(ctx, connector);
  resyncAgents(c, ctx);
  return c.json({
    connector: toConnectorView(
      (await getConnector(ctx.db, connector.workspaceId, connector.id)) ??
        connector
    ),
    result,
  });
});

// --- assignment -------------------------------------------------------------

connectorsRoutes.get("/:id/agents", async (c) => {
  const ctx = contextFor(c);
  const connector = await requireConnector(c, ctx, c.req.param("id"));
  const agentIds = await listAgentIdsForConnector(ctx.db, connector.id);
  const agents = await getAgentsByIds(ctx.db, agentIds);
  return c.json({
    agents: agents.map((agent) => ({
      avatar: agent.avatar,
      id: agent.id,
      name: agent.name,
    })),
  });
});

connectorsRoutes.post("/:id/agents", async (c) => {
  const ctx = contextFor(c);
  const connector = await requireConnector(c, ctx, c.req.param("id"));
  const agentId = requireString(await readJsonObject(c.req.raw), "agentId");
  if (!(await getAgentById(ctx.db, c.get("workspace").id, agentId))) {
    throw notFound("Agent not found.");
  }

  try {
    await assignConnector(ctx.db, connector.id, agentId);
  } catch (error) {
    return asHttpError(error);
  }
  // The vault list is fixed when a session is created, so an assignment made
  // now reaches the agent on its next one, once the resync below has rotated
  // its token and rewritten its `mcp_servers`.
  resyncAgents(c, ctx);
  return c.json({ appliesToNextSession: true, assigned: true }, 201);
});

connectorsRoutes.delete("/:id/agents/:agentId", async (c) => {
  const ctx = contextFor(c);
  const connector = await requireConnector(c, ctx, c.req.param("id"));
  const removed = await unassignConnector(
    ctx.db,
    connector.id,
    c.req.param("agentId")
  );
  if (!removed) {
    throw notFound("That agent is not assigned to this connector.");
  }
  resyncAgents(c, ctx);
  return c.body(null, 204);
});

// --- the OAuth callback -----------------------------------------------------

/**
 * A fixed page: it reports the outcome to whoever opened the popup and closes.
 * Nothing from the query string is interpolated into it, so there is nothing
 * here for a crafted callback URL to inject.
 */
const callbackPage = (ok: boolean): Response =>
  new Response(
    `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Connector authorization</title></head>
  <body style="font-family: system-ui; padding: 2rem">
    <p>${ok ? "Connected. You can close this window." : "Authorization failed. You can close this window and try again."}</p>
    <script>
      window.opener?.postMessage({ ok: ${ok}, type: "agentum:connector-oauth" }, window.location.origin);
      window.setTimeout(() => window.close(), 1200);
    </script>
  </body>
</html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: ok ? 200 : 400,
    }
  );

/**
 * Mounted open, ahead of the authed router. The authorization server redirects
 * a browser here, and the credential is the one-shot `state` we stored: it is
 * matched, expiry-checked and deleted before the code is ever exchanged. A
 * Clerk challenge here would only strand the popup.
 */
export const connectorOauthRoutes = new Hono<ApiEnv>();

connectorOauthRoutes.get("/oauth/callback", async (c) => {
  const error = c.req.query("error");
  if (error) {
    return callbackPage(false);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!(code && state)) {
    return callbackPage(false);
  }

  try {
    const ctx = contextFor(c);
    await completeOAuthCallback(ctx, { code, state });
    // A first authorization makes the connector attachable, so the agents
    // holding it need their servers pushed.
    resyncAgents(c, ctx);
    return callbackPage(true);
  } catch {
    return callbackPage(false);
  }
});
