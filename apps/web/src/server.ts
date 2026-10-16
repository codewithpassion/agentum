import { createClerkClient } from "@clerk/backend";
import { clerkMiddleware, getAuth } from "@clerk/hono";
import { trpcServer } from "@hono/trpc-server";
import { systemClock } from "@repo/services/runs/types";
import handler from "@tanstack/react-start/server-entry";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { MiddlewareHandler } from "hono/types";
import { compose } from "./server/compose.ts";
import { accessRoutes } from "./server/routes/access.ts";
import { automationRoutes } from "./server/routes/automation.ts";
import { devRoutes } from "./server/routes/dev.ts";
import type { AppEnv } from "./server/routes/groups.ts";
import { runtimeRoutes } from "./server/routes/runtime.ts";
import { tickJobs } from "./server/tick/jobs.ts";
import { runTick } from "./server/tick/registry.ts";
import { createHonoContext } from "./server/trpc/context.ts";
import { appRouter } from "./server/trpc/router.ts";

// Durable Object classes are exported from the Worker entry.
// biome-ignore lint/performance/noBarrelFile: the Worker entry must export the Durable Object class; the class lives in its own module so bun can test it
export { MachineRelay } from "./server/relay.ts";

const app = new Hono<AppEnv>();

app.use("*", clerkMiddleware());

// Every service, built once for the request from the bindings and secrets.
const composeServices: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("composed", compose(c.env, import.meta.env.DEV));
  await next();
};
app.use("/api/*", composeServices);
app.use("/mcp", composeServices);
// `/files/:id` is outside `/api` but reads files too.
app.use("/files/*", composeServices);

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

  const { data: memberships } =
    await clerkClient.users.getOrganizationMembershipList({ userId: user.id });
  const [membership] = memberships;
  if (!membership) {
    return c.text(
      `Dev login user ${email} has no organisation yet. Run "bun run create-dev-user" in apps/web.`,
      404
    );
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
app.route("/", runtimeRoutes);
app.route("/", accessRoutes);
app.route("/", automationRoutes);

// Local checks (the atomic probe, and the offer nudge the e2e script uses).
// Dev builds only.
if (import.meta.env.DEV) {
  app.route("/", devRoutes);
}

// Everything else is handled by TanStack Start (SSR pages and assets).
app.all("*", (c) => handler.fetch(c.req.raw));

/**
 * The minute tick (cron `* * * * *`). Runs every registered job once. Awaited,
 * so the dev scheduled-handler probe answers after the jobs finish.
 */
const scheduled: ExportedHandlerScheduledHandler<Env> = async (
  _controller,
  env
) => {
  const { services } = compose(env, import.meta.env.DEV);
  const report = await runTick(tickJobs, { clock: systemClock, services });
  console.log(JSON.stringify({ event: "tick", ...report }));
  for (const job of report.jobs) {
    if (!job.ok) {
      console.error(`Tick job ${job.name} failed: ${job.error}`);
    }
  }
};

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
