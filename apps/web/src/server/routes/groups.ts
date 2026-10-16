import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { Composed } from "../compose.ts";

export interface AppEnv {
  Bindings: Env;
  /** `composed` is set once per request by the middleware in server.ts. */
  Variables: { composed: Composed };
}

/**
 * A route group for routes authenticated by the Clerk session cookie. It
 * applies `csrf()`, which rejects cross-site form posts that a browser would
 * send with the cookie attached.
 *
 * Mount it under a path prefix: `app.route("/api/x", cookieGroup())`. A group
 * mounted at "/" applies its middleware to every request in the app.
 */
export const cookieGroup = (): Hono<AppEnv> => {
  const group = new Hono<AppEnv>();
  group.use("*", csrf());
  return group;
};

/**
 * A route group for routes authenticated by the Authorization header. It has
 * no csrf check. These routes never read cookies, and csrf would wrongly block
 * webhooks that send form bodies without an Origin header.
 *
 * Mount it under a path prefix: `app.route("/api/x", bearerGroup())`. A group
 * mounted at "/" applies its middleware to every request in the app.
 */
export const bearerGroup = (): Hono<AppEnv> => new Hono<AppEnv>();
