import { createClerkClient } from "@clerk/backend";
import { clerkMiddleware, getAuth } from "@clerk/hono";
import handler from "@tanstack/react-start/server-entry";
import { Hono } from "hono";
import { agentsRoutes } from "#/modules/agents/routes";
import { attachmentsRoutes } from "#/modules/messaging/routes/attachments";
import { channelsRoutes } from "#/modules/messaging/routes/channels";
import { messagesRoutes } from "#/modules/messaging/routes/messages";

// The Durable Object class must be re-exported from the Worker entry so the
// runtime can instantiate it for the CHANNEL_ROOM binding.
// biome-ignore lint/performance/noBarrelFile: the Workers runtime requires the DO class on the entry module
export { ChannelRoom } from "#/modules/messaging/channel-room";

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

// Workspace resources. Each router gates itself with `requireAuth`; the two
// routes above stay open by design.
app.route("/api/agents", agentsRoutes);
app.route("/api/channels", channelsRoutes);
app.route("/api/messages", messagesRoutes);
app.route("/api/attachments", attachmentsRoutes);

// Everything else is handled by TanStack Start (SSR pages, server functions, assets).
app.all("*", (c) => handler.fetch(c.req.raw));

export default app;
