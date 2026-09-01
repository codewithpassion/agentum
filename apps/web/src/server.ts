import { createClerkClient } from "@clerk/backend";
import { clerkMiddleware, getAuth } from "@clerk/hono";
import handler from "@tanstack/react-start/server-entry";
import { Hono } from "hono";
import { agentActivityRoutes } from "#/modules/activity/routes";
import { agentsRoutes } from "#/modules/agents/routes";
import { anthropicKeyRoutes } from "#/modules/anthropic/routes";
import {
  agentSlackAppRoutes,
  bridgeRoutes,
  bridgesRoutes,
} from "#/modules/bridges/routes";
import { slackRoutes } from "#/modules/bridges/slack/routes";
import { browserRoutes } from "#/modules/browser/routes";
import { categoriesRoutes } from "#/modules/categories/routes";
import { computerConnectRoutes } from "#/modules/computer/connect-route";
import { computerHostRoutes } from "#/modules/computer/host-routes";
import { computerRoutes } from "#/modules/computer/routes";
import {
  connectorOauthRoutes,
  connectorsRoutes,
} from "#/modules/connectors/routes";
import { mcpRoutes } from "#/modules/mcp/routes";
import { attachmentsRoutes } from "#/modules/messaging/routes/attachments";
import { channelsRoutes } from "#/modules/messaging/routes/channels";
import { messagesRoutes } from "#/modules/messaging/routes/messages";
import {
  agentQuestionsRoutes,
  questionsRoutes,
} from "#/modules/questions/routes";
import { routinesRoutes } from "#/modules/routines/routes";
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
export { ComputerRelay } from "#/modules/computer/relay";
export { ChannelRoom } from "#/modules/messaging/channel-room";
export { AgentRouter } from "#/modules/router/agent-router";
export { RoutineScheduler } from "#/modules/routines/scheduler";
export { AgentRunner } from "#/modules/runner/durable-object";

const app = new Hono<{ Bindings: Env }>();

app.use("*", clerkMiddleware());

// Whether the caller has a session, never who they are: the Clerk id does not
// leave the server, and "is my session live?" is all this route is asked.
app.get("/api/health", (c) => {
  const auth = getAuth(c);
  return c.json({ authenticated: Boolean(auth?.userId), status: "ok" });
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

// Every resource router, hung off `workspaceScopedRoutes` - which carries the
// `requireAuth` + `requireWorkspace` gates - so each one inherits both and
// reads its tenant from `c.get("workspace")`. This has to happen *before* the
// mount below: Hono copies a sub-router's routes at mount time, so anything
// added afterwards would never be reachable.
workspaceScopedRoutes.route("/agents", agentsRoutes);
// An agent's computer, its browser and its activity log read as part of the
// agent; Hono falls through to these for the paths `agentsRoutes` does not own.
workspaceScopedRoutes.route("/agents", computerRoutes);
workspaceScopedRoutes.route("/agents", browserRoutes);
workspaceScopedRoutes.route("/agents", agentActivityRoutes);
// The agent's Slack connection wizard, on the same fall-through principle.
workspaceScopedRoutes.route("/agents", agentSlackAppRoutes);
// And the questions it is waiting on, which read as part of the agent too.
workspaceScopedRoutes.route("/agents", agentQuestionsRoutes);
workspaceScopedRoutes.route("/channels", channelsRoutes);
workspaceScopedRoutes.route("/categories", categoriesRoutes);
workspaceScopedRoutes.route("/messages", messagesRoutes);
workspaceScopedRoutes.route("/attachments", attachmentsRoutes);
workspaceScopedRoutes.route("/wiki", wikiRoutes);
workspaceScopedRoutes.route("/connectors", connectorsRoutes);
// Where an agent's computer may run - Fly apps and self-hosted containers.
// Members may list them; only owners may add, change or remove one.
workspaceScopedRoutes.route("/computer-hosts", computerHostRoutes);
// The workspace's own Anthropic API key - owner-only, and write-only: the
// router hands back a hint, never the key.
workspaceScopedRoutes.route("/anthropic-key", anthropicKeyRoutes);
// Skills (versioned SKILL.md bundles, mirrored to Anthropic).
workspaceScopedRoutes.route("/skills", skillsRoutes);
// Routines: scheduled instructions, fired into a channel by the per-workspace
// RoutineScheduler Durable Object exported above.
workspaceScopedRoutes.route("/routines", routinesRoutes);
// Questions agents asked their humans, and the answers that wake them.
workspaceScopedRoutes.route("/questions", questionsRoutes);
// Bridge management lives in the bridges module but reads as part of a
// channel; Hono falls through to it for the paths `channelsRoutes` does not own.
workspaceScopedRoutes.route("/channels", bridgeRoutes);
workspaceScopedRoutes.route("/bridges", bridgesRoutes);

// Everything that happens *inside* a workspace, resource routers included.
app.route("/api/w/:workspaceSlug", workspaceScopedRoutes);

// The connector OAuth callback. Outside the workspace prefix and outside
// `requireAuth`: an authorization server redirects a browser to it, and the
// one-shot `state` it carries is the credential - which is also what names the
// workspace, since the flow row it matches carries one.
app.route("/api/connectors", connectorOauthRoutes);

// The Slack Events API endpoints - one per connected agent, addressed by its
// `slack_apps` row id. Not behind Clerk: Slack signs its requests with that
// app's signing secret, and the signature is checked before anything in the
// payload is trusted.
app.route("/api/bridges/slack", slackRoutes);

// The agents' MCP endpoint. Not behind Clerk: the per-agent token in the path
// is the credential (see modules/mcp/routes).
app.route("/mcp", mcpRoutes);

// Where a self-hosted computerd container dials in. Not behind Clerk either:
// the host token in the Authorization header is the credential, and it names
// the host whose relay the socket is handed to (see modules/computer/connect-route).
app.route("/api/computer-hosts", computerConnectRoutes);

// Everything else is handled by TanStack Start (SSR pages, server functions, assets).
app.all("*", (c) => handler.fetch(c.req.raw));

export default app;
