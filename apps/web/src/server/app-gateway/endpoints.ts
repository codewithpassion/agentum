import type { Context, Hono } from "hono";
import type { AppEnv } from "../routes/groups.ts";
import {
  type EndpointWiring,
  handleEndpointRoute,
} from "./endpoint-handler.ts";
import type { ApiLimiter } from "./mount.ts";

export const mountEndpointRoutes = (
  app: Hono<AppEnv>,
  deps: {
    limiter?: (env: Env) => ApiLimiter | undefined;
    wiring: (c: Context<AppEnv>) => EndpointWiring;
  }
) => {
  const handler = (c: Context<AppEnv>) =>
    handleEndpointRoute(c.req.raw, c.req.param("id") ?? "", {
      defer: (work) => {
        // Unit tests may have no execution context. The caught log still runs.
        try {
          c.executionCtx.waitUntil(work);
        } catch {
          /* Workers always supplies a context. */
        }
      },
      limiter: deps.limiter?.(c.env),
      wiring: () => deps.wiring(c),
    });
  app.all("/hooks/:id", handler);
  app.all("/hooks/:id/*", handler);
};
