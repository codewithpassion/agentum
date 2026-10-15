// What every tRPC procedure receives as `ctx`: the services, built on this
// request's D1 binding, and who is calling. `userId` is the Clerk user, or
// null for anonymous callers; `protectedProcedure` rejects the latter.
import { env } from "cloudflare:workers";
import { getAuth } from "@clerk/hono";
import { auth } from "@clerk/tanstack-react-start/server";
import { createNotesService } from "@repo/services/notes";
import { drizzle } from "drizzle-orm/d1";
import type { Context as HonoContext } from "hono";

// A type, not an interface: see the biome-ignore. Over HTTP,
// @hono/trpc-server also adds `env` to ctx, but the SSR path does not, so
// procedures use `ctx.services` and never `ctx.env`.
// biome-ignore lint/style/useConsistentTypeDefinitions: @hono/trpc-server needs a Record<string, unknown>, which an interface is not
export type Context = {
  services: { notes: ReturnType<typeof createNotesService> };
  /** Signed-in user, or null for anonymous callers. */
  userId: string | null;
};

const createContext = (bindings: Env, userId: string | null): Context => {
  const db = drizzle(bindings.DB);
  return { services: { notes: createNotesService(db) }, userId };
};

/**
 * Calls over HTTP: /api/trpc, mounted in src/server.ts after @clerk/hono's
 * clerkMiddleware(), which is what getAuth(c) reads.
 */
export const createHonoContext = (
  c: HonoContext<{ Bindings: Env }>
): Promise<Context> =>
  Promise.resolve(createContext(c.env, getAuth(c)?.userId ?? null));

/**
 * In-process calls from route loaders during SSR (src/integrations/trpc).
 * auth() reads the session the Clerk request middleware in src/start.ts set.
 */
export const createSsrContext = async (): Promise<Context> => {
  const { userId } = await auth();
  return createContext(env, userId);
};
