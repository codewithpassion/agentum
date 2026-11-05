import type { ArtifactEndpointsService } from "@repo/services/artifacts/endpoints";
import { truncateIp } from "@repo/services/artifacts/view-privacy";
import type { Context, Hono } from "hono";
import { withContentHeaders } from "../artifact-content/headers.ts";
import type { AppEnv } from "../routes/groups.ts";
import { handleEndpointRequest } from "./gateway-core.ts";
import type { ApiLimiter, AppGatewayWiring } from "./mount.ts";

interface EndpointWiring extends AppGatewayWiring {
  endpoints: Pick<ArtifactEndpointsService, "resolve" | "recordCall">;
}
/** Check the IP-only budget before spending an endpoint budget or reading D1. */
const withinLimits = async (
  limiter: ApiLimiter,
  id: string,
  prefix: string
): Promise<boolean> => {
  // APP_API_LIMIT allows 300 checks/minute per key. Two fixed IP-only
  // buckets allow 600/minute across all ids; overflow never depends on id.
  const ipKey = `api:endpoints:ip:${prefix}`;
  const primary = await limiter.limit({ key: ipKey });
  if (
    !(
      primary.success ||
      (await limiter.limit({ key: `${ipKey}:overflow` })).success
    )
  ) {
    return false;
  }
  return (await limiter.limit({ key: `api:endpoint:${id}:ip:${prefix}` }))
    .success;
};

export const mountEndpointRoutes = (
  app: Hono<AppEnv>,
  deps: {
    limiter?: (env: Env) => ApiLimiter | undefined;
    wiring: (c: Context<AppEnv>) => EndpointWiring;
  }
) => {
  const handler = async (c: Context<AppEnv>) => {
    const start = performance.now();
    const timing = { appResponse: 0, limiter: 0, meta: 0, resolve: 0 };
    let name: string | null = null;
    const timed = async <T>(
      stage: keyof typeof timing,
      run: () => Promise<T>
    ): Promise<T> => {
      const started = performance.now();
      try {
        return await run();
      } finally {
        timing[stage] += performance.now() - started;
      }
    };
    const finish = (response: Response) => {
      const wrapped = withContentHeaders(response, {
        appOrigin: new URL(c.req.url).origin,
        contentBase: null,
      });
      wrapped.headers.set("Cache-Control", "private, no-store");
      return wrapped;
    };
    try {
      const id = c.req.param("id") ?? "";
      const limiter = deps.limiter?.(c.env);
      const ip = c.req.header("CF-Connecting-IP");
      const prefix = ip ? truncateIp(ip) : null;
      if (
        limiter &&
        !(await timed("limiter", () =>
          withinLimits(limiter, id, prefix ?? "unknown")
        ))
      ) {
        return finish(
          new Response("Too many requests.", {
            headers: { "Retry-After": "60" },
            status: 429,
          })
        );
      }
      const wiring = deps.wiring(c);
      const endpoint = await timed("resolve", () =>
        wiring.endpoints.resolve(id)
      );
      if (!endpoint) {
        return finish(new Response("Not found.", { status: 404 }));
      }
      ({ name } = endpoint);
      const meta = await timed("meta", () =>
        wiring.requestMeta(c.req.raw, endpoint.workspaceId)
      );
      const started = performance.now();
      const response = await timed("appResponse", () =>
        handleEndpointRequest(c.req.raw, endpoint, {
          ...wiring,
          applyContentHeaders: finish,
          requestMeta: () => Promise.resolve(meta),
        })
      );
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      const log = Promise.resolve()
        .then(() =>
          wiring.endpoints.recordCall(
            endpoint,
            meta,
            response.status >= 500 ? "error" : "ok",
            { durationMs, statusCode: response.status }
          )
        )
        .catch(() => {
          console.error("Failed to record endpoint call", {
            artifactId: endpoint.artifactId,
            endpointId: endpoint.endpointId,
            versionId: endpoint.versionId,
            workspaceId: endpoint.workspaceId,
          });
        });
      // Hono tests may have no execution context; Workers always supplies it.
      try {
        c.executionCtx.waitUntil(log);
      } catch {
        /* The caught log still runs. */
      }
      return response;
    } catch {
      return finish(
        new Response("The app's server could not answer.", { status: 502 })
      );
    } finally {
      console.log(
        "app endpoint timing",
        JSON.stringify({
          appResponse: Math.round(timing.appResponse),
          endpoint: name,
          limiter: Math.round(timing.limiter),
          meta: Math.round(timing.meta),
          resolve: Math.round(timing.resolve),
          total: Math.round(performance.now() - start),
        })
      );
    }
  };
  app.all("/hooks/:id", handler);
  app.all("/hooks/:id/*", handler);
};
