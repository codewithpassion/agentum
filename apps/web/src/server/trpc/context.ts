// What every tRPC procedure receives as `ctx`: the services, and who is
// calling. `principal` is the user in their workspace, or null when signed
// out, without an organisation, or in an organisation that is not in
// ALLOWED_ORG_IDS. `workspaceProcedure` rejects the null case.

import { env } from "cloudflare:workers";
import { getAuth } from "@clerk/hono";
import { auth } from "@clerk/tanstack-react-start/server";
import type { AgentsService } from "@repo/services/agents";
import type { RunsService } from "@repo/services/runs";
import type {
  createWorkspacesService,
  Principal,
} from "@repo/services/workspaces";
import { drizzle } from "drizzle-orm/d1";
import type { Context as HonoContext } from "hono";
import { buildContext, d1Infra, parseOrgIds } from "./build-context.ts";

// A type, not an interface: see the biome-ignore. Over HTTP,
// @hono/trpc-server also adds `env` to ctx, but the SSR path does not, so
// procedures use `ctx.services` and never `ctx.env`.
// biome-ignore lint/style/useConsistentTypeDefinitions: @hono/trpc-server needs a Record<string, unknown>, which an interface is not
export type Context = {
  principal: Principal | null;
  services: {
    agents: AgentsService;
    runs: RunsService;
    workspaces: ReturnType<typeof createWorkspacesService>;
  };
};

/**
 * Calls over HTTP: /api/trpc, mounted in src/server.ts after @clerk/hono's
 * clerkMiddleware(), which is what getAuth(c) reads.
 */
export const createHonoContext = (
  c: HonoContext<{ Bindings: Env }>
): Promise<Context> => {
  const { userId, orgId } = getAuth(c) ?? {};
  const db = drizzle(c.env.DB);
  return buildContext({
    allowedOrgIds: parseOrgIds(c.env.ALLOWED_ORG_IDS),
    db,
    infra: d1Infra(db, import.meta.env.DEV),
    session: { orgId, userId: userId ?? null },
  });
};

/**
 * In-process calls from route loaders during SSR (src/integrations/trpc).
 * auth() reads the session the Clerk request middleware in src/start.ts set.
 */
export const createSsrContext = async (): Promise<Context> => {
  const { userId, orgId } = await auth();
  const db = drizzle(env.DB);
  return buildContext({
    allowedOrgIds: parseOrgIds(env.ALLOWED_ORG_IDS),
    db,
    infra: d1Infra(db, import.meta.env.DEV),
    session: { orgId, userId },
  });
};
