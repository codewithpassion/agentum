import { createClerkClient } from "@clerk/backend";
import { clerkMiddleware, getAuth } from "@clerk/hono";
import handler from "@tanstack/react-start/server-entry";
import { Hono } from "hono";
import { agentActivityRoutes } from "#/modules/activity/routes";
import { agentsRoutes } from "#/modules/agents/routes";
import { bridgeRoutes, bridgesRoutes } from "#/modules/bridges/routes";
import { slackRoutes } from "#/modules/bridges/slack/routes";
import { browserRoutes } from "#/modules/browser/routes";
import { categoriesRoutes } from "#/modules/categories/routes";
import { computerRoutes } from "#/modules/computer/routes";
import {
  connectorOauthRoutes,
  connectorsRoutes,
} from "#/modules/connectors/routes";
import { mcpRoutes } from "#/modules/mcp/routes";
import { attachmentsRoutes } from "#/modules/messaging/routes/attachments";
import { channelsRoutes } from "#/modules/messaging/routes/channels";
import { messagesRoutes } from "#/modules/messaging/routes/messages";
import { skillsRoutes } from "#/modules/skills/routes";
import { wikiRoutes } from "#/modules/wiki/routes";
import {
  workspaceScopedRoutes,
  workspacesRoutes,
} from "#/modules/workspaces/routes";

// Durable Object classes must be re-exported from the Worker entry so the
// runtime can instantiate them for the CHANNEL_ROOM and AGENT_ROUTER bindings.
// biome-ignore lint/performance/noBarrelFile: the Workers runtime requires the DO class on the entry module
export {
  AgentComputer,
  WorkspaceServiceProxy,
} from "#/modules/computer/durable-object";
export { ChannelRoom } from "#/modules/messaging/channel-room";
export { AgentRouter } from "#/modules/router/agent-router";

const app = new Hono<{ Bindings: Env }>();

app.use("*", clerkMiddleware());

app.get("/api/health", (c) => {
  const auth = getAuth(c);
  return c.json({ status: "ok", userId: auth?.userId ?? null });
});

// One-click dev login: mints a one-time Clerk sign-in token for the dev user
// and hands it to /dev-login to redeem client-side. Only active when
// DEV_LOGIN_EMAIL is configured, which must never be set in a deployed
// environment - that absence is the safety switch for this route.
app.get("/api/dev-login", async (c) => {
  const email = c.env.DEV_LOGIN_EMAIL;
  if (!email) {
    return c.text("Dev login is not configured.", 404);
  }

  const clerkClient = createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY });
  const { data } = await clerkClient.users.getUserList({
    emailAddress: [email],
  });
  const [user] = data;
  if (!user) {
    return c.text(
      `Dev login user ${email} does not exist yet. Run "bun run create-dev-user" in apps/web.`,
      404
    );
  }

  const { token } = await clerkClient.signInTokens.createSignInToken({
    expiresInSeconds: 60,
    userId: user.id,
  });

  return c.redirect(`/dev-login?token=${encodeURIComponent(token)}`);
});

// "My workspaces", and creating one: the only workspace routes that name no
// workspace, so they gate on `requireAuth` alone.
app.route("/api/workspaces", workspacesRoutes);

// Everything that happens *inside* a workspace: the router carries its own
// `requireAuth` + `requireWorkspace` gates, and Phase 3 hangs the resource
// routers below off the same instance - `workspaceScopedRoutes.route(
// "/agents", agentsRoutes)` - before this mount, which is what scopes them.
app.route("/api/w/:slug", workspaceScopedRoutes);

// Workspace resources. Each router gates itself with `requireAuth`; the two
// routes above stay open by design.
app.route("/api/agents", agentsRoutes);
// An agent's computer, its browser and its activity log read as part of the
// agent; Hono falls through to these for the paths `agentsRoutes` does not own.
app.route("/api/agents", computerRoutes);
app.route("/api/agents", browserRoutes);
app.route("/api/agents", agentActivityRoutes);
app.route("/api/channels", channelsRoutes);
app.route("/api/categories", categoriesRoutes);
app.route("/api/messages", messagesRoutes);
app.route("/api/attachments", attachmentsRoutes);
app.route("/api/wiki", wikiRoutes);
// Connectors (remote MCP servers). The OAuth callback is mounted first and
// stays outside `requireAuth`: an authorization server redirects a browser to
// it, and the one-shot `state` it carries is the credential.
app.route("/api/connectors", connectorOauthRoutes);
app.route("/api/connectors", connectorsRoutes);
// Skills (versioned SKILL.md bundles, mirrored to Anthropic).
app.route("/api/skills", skillsRoutes);
// Bridge management lives in the bridges module but reads as part of a
// channel; Hono falls through to it for the paths `channelsRoutes` does not own.
app.route("/api/channels", bridgeRoutes);
app.route("/api/bridges", bridgesRoutes);

// Slack's Events API endpoint. Not behind Clerk: Slack signs its requests, and
// the signature is checked before anything in the payload is trusted.
app.route("/api/bridges/slack", slackRoutes);

// The agents' MCP endpoint. Not behind Clerk: the per-agent token in the path
// is the credential (see modules/mcp/routes).
app.route("/mcp", mcpRoutes);

// Everything else is handled by TanStack Start (SSR pages, server functions, assets).
app.all("*", (c) => handler.fetch(c.req.raw));

export default app;
