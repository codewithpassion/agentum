// What every tRPC procedure receives as `ctx`: the services, and who is
// calling. `principal` is the user in their workspace, or null when signed
// out, without an organisation, or in an organisation with no workspace row.
// `workspaceProcedure` rejects the null case.

import { env } from "cloudflare:workers";
import { getAuth } from "@clerk/hono";
import { auth } from "@clerk/tanstack-react-start/server";
import type { Principal } from "@repo/services/workspaces";
import type { Context as HonoContext } from "hono";
import { compose, type Services } from "../compose.ts";
import type { AppEnv } from "../routes/groups.ts";
import { buildContext } from "./build-context.ts";

// A type, not an interface: see the biome-ignore. Over HTTP,
// @hono/trpc-server also adds `env` to ctx, but the SSR path does not, so
// procedures use `ctx.services` and never `ctx.env`.
// biome-ignore lint/style/useConsistentTypeDefinitions: @hono/trpc-server needs a Record<string, unknown>, which an interface is not
export type Context = {
  principal: Principal | null;
  services: Services;
};

/**
 * Calls over HTTP: /api/trpc, mounted in src/server.ts after @clerk/hono's
 * clerkMiddleware(), which is what getAuth(c) reads, and after the middleware
 * that composes the services once for the request.
 */
export const createHonoContext = (c: HonoContext<AppEnv>): Promise<Context> => {
  const { userId, orgId, orgRole } = getAuth(c) ?? {};
  return buildContext({
    composed: c.get("composed"),
    session: { orgId, orgRole, userId: userId ?? null },
  });
};

/**
 * In-process calls from route loaders during SSR (src/integrations/trpc).
 * auth() reads the session the Clerk request middleware in src/start.ts set.
 */
export const createSsrContext = async (): Promise<Context> => {
  const { userId, orgId, orgRole } = await auth();
  return buildContext({
    composed: compose(env, import.meta.env.DEV),
    session: { orgId, orgRole, userId },
  });
};
