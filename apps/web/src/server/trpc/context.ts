// What every tRPC procedure receives as `ctx`: the services, built on this
// request's D1 binding, and who is calling. There is no auth yet, so `userId`
// is always null and every `protectedProcedure` answers UNAUTHORIZED. The
// add-clerk skill replaces this file with one that reads the Clerk session.
import { env } from "cloudflare:workers";
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

/** Calls over HTTP: /api/trpc, mounted in src/server.ts. */
export const createHonoContext = (
  c: HonoContext<{ Bindings: Env }>
): Promise<Context> => Promise.resolve(createContext(c.env, null));

/** In-process calls from route loaders during SSR (src/integrations/trpc). */
export const createSsrContext = (): Promise<Context> =>
  Promise.resolve(createContext(env, null));
