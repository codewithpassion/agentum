import { createClerkClient } from "@clerk/backend";
import { clerkMiddleware, getAuth } from "@clerk/hono";
import { trpcServer } from "@hono/trpc-server";
import { systemClock } from "@repo/services/runs/types";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import handler from "@tanstack/react-start/server-entry";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { MiddlewareHandler } from "hono/types";
import guestEntry from "./guest-entry.tsx?worker&url";
import { mountEndpointRoutes } from "./server/app-gateway/endpoints.ts";
import { mountAppGatewayRoutes } from "./server/app-gateway/mount.ts";
import { appGatewayWiring } from "./server/app-gateway/wiring.ts";
import { mountArtifactContentRoutes } from "./server/artifact-content/routes.ts";
import { compose } from "./server/compose.ts";
import { frameGuard } from "./server/frame-guard.ts";
import { setInProcessDispatch } from "./server/in-process.ts";
import { legacyHost } from "./server/legacy-host.ts";
import { guestEmbeds } from "./server/live-artifacts/guest-embeds";
import { guestRoutes } from "./server/live-artifacts/guest-routes";
import {
  liveImageRoutes,
  liveRoomRoutes,
} from "./server/live-artifacts/routes";
import { liveExportRoutes } from "./server/live-exports/routes";
import { handleMailEvents } from "./server/mail-events.ts";
import { handleInboundEmail } from "./server/mail-inbound.ts";
import installDaemonScript from "./server/releases/install.sh?raw";
import installComputerScript from "./server/releases/install-computer.sh?raw";
import { mountA2aRoutes } from "./server/routes/a2a.ts";
import { mountA2aWebhooks } from "./server/routes/a2a-webhooks.ts";
import { accessRoutes } from "./server/routes/access.ts";
import { artifactRoutes } from "./server/routes/artifacts.ts";
import { automationRoutes } from "./server/routes/automation.ts";
import { devRoutes } from "./server/routes/dev.ts";
import type { AppEnv } from "./server/routes/groups.ts";
import { mountReleaseRoutes } from "./server/routes/releases.ts";
import { runtimeRoutes } from "./server/routes/runtime.ts";
import { tickJobs } from "./server/tick/jobs.ts";
import { runTick } from "./server/tick/registry.ts";
import { createHonoContext } from "./server/trpc/context.ts";
import { appRouter } from "./server/trpc/router.ts";

// Durable Object classes are exported from the Worker entry, and so is the
// Sandbox SDK's gateway between a Linux VM and its snapshots in R2, which the
// VM's Durable Object reaches through `ctx.exports`.
// biome-ignore lint/performance/noBarrelFile: the Worker entry must export the Durable Object class; the class lives in its own module so bun can test it
export { DirectoryBackupGateway } from "@cloudflare/sandbox";
export { AppHost, AppOutbound } from "./server/app-entrypoints.ts";
export { AppStore } from "./server/app-store/app-store.ts";
export { GuestRun } from "./server/guest-run";
export { VmSession } from "./server/linux-vm/vm-session.ts";
export { LiveArtifactMaintenance } from "./server/live-artifacts/maintenance";
export { ArtifactRoom } from "./server/live-artifacts/production-room";
export { MailboxDO } from "./server/mailbox.ts";
export { ManagedPoller } from "./server/managed-poller.ts";
export { PiRun } from "./server/pi-run.ts";
export { MachineRelay } from "./server/relay.ts";
export { ScriptHost } from "./server/script-host.ts";
export { SecretsOutbound } from "./server/secrets-outbound.ts";
export { SessionStream } from "./server/session-stream.ts";

const app = new Hono<AppEnv>();

// A page load on an old hostname (LEGACY_HOSTS) moves to PUBLIC_BASE_URL. First,
// so the redirect happens before anything else runs.
app.use("*", legacyHost);

// No page the app serves may be framed (R1.21a). Artifact content sets its own.
app.use("*", frameGuard);

// The server part of an app artifact, `/a/<uuid>/c/<token>/api/*`. Before the
// content routes, which refuse every method but GET. Builds its own services.
mountAppGatewayRoutes(app, {
  limiter: (env) => (env as Partial<Env>).APP_API_LIMIT,
  viewKey: (env) => env.ARTIFACT_VIEW_KEY,
  wiring: (c) => appGatewayWiring(c.env, c.executionCtx, import.meta.env.DEV),
});

// Public app ingress is deliberately before Clerk and all cookie/CSRF groups.
mountEndpointRoutes(app, {
  limiter: (env) => (env as Partial<Env>).APP_API_LIMIT,
  wiring: (c) => appGatewayWiring(c.env, c.executionCtx, import.meta.env.DEV),
});

// Artifact content: signed view tokens, R2 only. Mounted before Clerk and the
// compose middleware, so these paths never reach either (R1.21a).
mountArtifactContentRoutes(app, {
  authorizeGuestEmbed: (claims, env) =>
    guestEmbeds(env, compose(env, false)).authorize(claims),
  bucket: (env) => env.FILES,
  viewKey: (env) => env.ARTIFACT_VIEW_KEY,
  workspaceId: (claims) => claims.workspaceId,
});

// The install scripts and the daemon and computer binaries (`/install.sh`,
// `/releases/...`), public and read from R2. Before Clerk, so no sign-in
// redirect can catch `curl`.
mountReleaseRoutes(app, {
  bucket: (env) => env.FILES,
  scripts: { computer: installComputerScript, daemon: installDaemonScript },
});

app.route(
  "/",
  guestRoutes({
    compose: (env) => compose(env, false),
    page: async () =>
      new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Shared with you · Agentum</title></head><body><div id="guest-root"></div><script type="module" src="${guestEntry}"></script></body></html>`,
        {
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "text/html; charset=utf-8",
            "Referrer-Policy": "no-referrer",
          },
        }
      ),
  })
);
app.route("/", liveRoomRoutes());

// Every service, built once for the request from the bindings and secrets.
const composeServices: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set(
    "composed",
    compose(
      c.env,
      import.meta.env.DEV,
      (work) => {
        c.executionCtx.waitUntil(work);
      },
      c.executionCtx.exports
    )
  );
  await next();
};

// The A2A server (`/a2a/<publicId>/...`, `/a2a/pair/join`). Callers are other
// servers with a bearer key and no cookie, so it takes no csrf check and must
// never meet Clerk: on a dev instance clerkMiddleware answers a browser-style
// request with a handshake redirect. It is mounted ahead of `clerkMiddleware`
// and ends every path under `/a2a` itself, so nothing falls through to the pages.
// A peer's push webhook (`/a2a/webhooks/<taskId>/<token>`) is mounted first, so
// it answers its own path and never reaches the pairing or peer-token handling
// in `mountA2aRoutes`, whose last route answers every other path 404.
mountA2aWebhooks(app, composeServices);
mountA2aRoutes(app, composeServices);

app.use("*", clerkMiddleware());
app.use("/api/*", composeServices);
app.use("/mcp", composeServices);
// A workspace's own MCP address, `/mcp/<workspaceId>`.
app.use("/mcp/*", composeServices);
// `/files/:id` is outside `/api` but reads files too.
app.use("/files/*", composeServices);
// `/connect/:id` starts an OAuth connection and reads the services too.
app.use("/connect/*", composeServices);

app.get("/api/health", (c) => {
  const auth = getAuth(c);
  return c.json({ status: "ok", userId: auth?.userId ?? null });
});

// One-click dev login: mints a one-time Clerk sign-in token for the dev user
// and hands it to /dev-login to redeem client-side. Only active when
// DEV_LOGIN_EMAIL is configured, which must never be set in a deployed
// environment - that absence is the safety switch for this route. A dev build
// also makes the dev organisation's workspace row.
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

  const { data: memberships } =
    await clerkClient.users.getOrganizationMembershipList({ userId: user.id });
  const [membership] = memberships;
  if (!membership) {
    return c.text(
      `Dev login user ${email} has no organisation yet. Run "bun run create-dev-user" in apps/web.`,
      404
    );
  }

  // A workspace row is what admits an organisation. A clean `.wrangler` has
  // none, so the dev login makes the one for the dev organisation, in dev
  // builds only.
  if (import.meta.env.DEV) {
    await c.get("composed").services.workspaces.create({
      clerkOrgId: membership.organization.id,
      name: membership.organization.name,
    });
  }

  const { token } = await clerkClient.signInTokens.createSignInToken({
    expiresInSeconds: 60,
    userId: user.id,
  });

  return c.redirect(
    `/dev-login?token=${encodeURIComponent(token)}&org=${encodeURIComponent(membership.organization.id)}`
  );
});

// tRPC: queries and mutations for the browser. During SSR the loaders call the
// same router in-process instead (src/integrations/trpc/client.ts).
// csrf() rejects cross-site POSTs with form content types, which browsers send
// without a preflight. JSON POSTs are safe only because a cross-site one needs
// a CORS preflight that nothing here answers: adding cors() to these routes
// would leave mutations open to CSRF.
app.use("/api/trpc/*", csrf());
app.use(
  "/api/trpc/*",
  trpcServer({
    createContext: (_opts, c) => createHonoContext(c),
    endpoint: "/api/trpc",
    // Production clients only see "Internal server error" (see init.ts), so
    // the real error goes to the Worker logs.
    onError: ({ error, path }) => {
      if (error.code === "INTERNAL_SERVER_ERROR") {
        console.error(`tRPC ${path ?? "?"} failed:`, error.cause ?? error);
      }
    },
    router: appRouter,
  })
);

// One route app per lane, each mounted once here. Lanes edit their own file.
app.route("/", liveImageRoutes());
app.route("/", liveExportRoutes());
app.route("/", runtimeRoutes);
app.route("/", accessRoutes);
app.route("/", automationRoutes);
app.route("/", artifactRoutes({ session: (c) => getAuth(c) }));

// Local checks (the atomic probe, and the offer nudge the e2e script uses).
// Dev builds only.
if (import.meta.env.DEV) {
  app.route("/", devRoutes);
}

// Everything else is handled by TanStack Start (SSR pages and assets).
app.all("*", (c) => handler.fetch(c.req.raw));

// A message to a workspace on this deployment is dispatched here, in-process:
// a Worker cannot fetch its own hostname (see server/in-process.ts).
setInProcessDispatch((request, env, ctx) => app.fetch(request, env, ctx));

/**
 * The minute tick (cron `* * * * *`). Runs every registered job once. Awaited,
 * so the dev scheduled-handler probe answers after the jobs finish.
 */
const scheduled: ExportedHandlerScheduledHandler<Env> = async (
  _controller,
  env,
  ctx
) => {
  const { services } = compose(
    env,
    import.meta.env.DEV,
    (w) => ctx.waitUntil(w),
    ctx.exports
  );
  const report = await runTick(tickJobs, { clock: systemClock, services });
  console.log(JSON.stringify({ event: "tick", ...report }));
  for (const job of report.jobs) {
    if (!job.ok) {
      console.error(`Tick job ${job.name} failed: ${job.error}`);
    }
  }
};

/**
 * Mail for an agent address. Email Routing calls this for each message that a
 * literal rule sends to the Worker. A thrown error makes the sender retry.
 */
const email: EmailExportedHandler<Env> = async (message, env, ctx) => {
  const { services } = compose(
    env,
    import.meta.env.DEV,
    (w) => ctx.waitUntil(w),
    ctx.exports
  );
  await handleInboundEmail(
    {
      from: message.from,
      raw: message.raw,
      rawSize: message.rawSize,
      setReject: (reason) => message.setReject(reason),
      to: message.to,
    },
    {
      isActive: (address) =>
        services.mail.agent.isActiveAddress(SYSTEM_PRINCIPAL, address),
      receive: (inbound) => services.mail.receive(inbound),
    }
  );
};

/**
 * Email Sending events for outbound agent mail, from the queue the sending
 * domain's subscription feeds. Bounces and failures mark the sent mail.
 */
const queue: ExportedHandlerQueueHandler<Env, unknown> = async (
  batch,
  env,
  ctx
) => {
  const { services } = compose(
    env,
    import.meta.env.DEV,
    (w) => ctx.waitUntil(w),
    ctx.exports
  );
  await handleMailEvents(batch.messages, {
    record: (report) =>
      services.mail.recordUndelivered(SYSTEM_PRINCIPAL, report),
  });
};

export default {
  email,
  fetch: app.fetch,
  queue,
  scheduled,
} satisfies ExportedHandler<Env>;
