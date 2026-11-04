import type { ArtifactEndpointsService } from "@repo/services/artifacts/endpoints";
import { truncateIp } from "@repo/services/artifacts/view-privacy";
import type { Context, Hono } from "hono";
import { withContentHeaders } from "../artifact-content/headers.ts";
import type { AppEnv } from "../routes/groups.ts";
import { handleEndpointRequest } from "./gateway-core.ts";
import type { ApiLimiter, AppGatewayWiring } from "./mount.ts";

interface EndpointWiring extends AppGatewayWiring {
  endpoints: Pick<
    ArtifactEndpointsService,
    "resolve" | "recordCall" | "workspaceIdOf"
  >;
}
export const mountEndpointRoutes = (
  app: Hono<AppEnv>,
  deps: {
    limiter?: (env: Env) => ApiLimiter | undefined;
    wiring: (c: Context<AppEnv>) => EndpointWiring;
  }
) => {
  const handler = async (c: Context<AppEnv>) => {
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
      const wiring = deps.wiring(c);
      const endpoint = await wiring.endpoints.resolve(id);
      const workspaceId =
        endpoint?.workspaceId ?? (await wiring.endpoints.workspaceIdOf(id));
      const meta = workspaceId
        ? await wiring.requestMeta(c.req.raw, workspaceId)
        : { ipPrefix: null, place: null, userAgent: null, visitorHash: "" };
      if (!endpoint) {
        await wiring.endpoints.recordCall(id, meta, "refused");
        return finish(new Response("Not found.", { status: 404 }));
      }
      const limiter = deps.limiter?.(c.env);
      const ip = c.req.header("CF-Connecting-IP");
      const prefix = ip ? truncateIp(ip) : null;
      // One endpoint budget and an endpoint-scoped IP-prefix budget, using the existing binding.
      const keys = [
        `api:endpoint:${id}`,
        `api:endpoint:${id}:ip:${prefix ?? "unknown"}`,
      ];
      if (
        limiter &&
        !(await Promise.all(keys.map((key) => limiter.limit({ key })))).every(
          (result) => result.success
        )
      ) {
        await wiring.endpoints.recordCall(id, meta, "rate_limited");
        return finish(
          new Response("Too many requests.", {
            headers: { "Retry-After": "60" },
            status: 429,
          })
        );
      }
      const response = await handleEndpointRequest(c.req.raw, endpoint, {
        ...wiring,
        applyContentHeaders: finish,
        requestMeta: () => Promise.resolve(meta),
      });
      await wiring.endpoints.recordCall(
        id,
        meta,
        response.status >= 500 ? "error" : "ok"
      );
      return response;
    } catch {
      return finish(
        new Response("The app's server could not answer.", { status: 502 })
      );
    }
  };
  app.all("/hooks/:id", handler);
  app.all("/hooks/:id/*", handler);
};
