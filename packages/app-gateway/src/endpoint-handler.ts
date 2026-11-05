import type { ArtifactEndpointsService } from "@repo/services/artifacts/endpoints";
import {
  cutUserAgent,
  truncateIp,
} from "@repo/services/artifacts/view-privacy";
import { withContentHeaders } from "./content-headers.ts";
import {
  type ApiLimiter,
  type AppGatewayWiring,
  handleEndpointRequest,
} from "./gateway-core.ts";

export interface EndpointWiring extends AppGatewayWiring {
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

export const handleEndpointRoute = async (
  request: Request,
  id: string,
  deps: {
    limiter?: ApiLimiter;
    wiring: () => EndpointWiring;
    defer?: (work: Promise<void>) => void;
    timing?: { label: string; bundle: () => number };
  }
): Promise<Response> => {
  const start = performance.now();
  const timing = { appResponse: 0, limiter: 0, resolve: 0 };
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
      appOrigin: new URL(request.url).origin,
      contentBase: null,
    });
    wrapped.headers.set("Cache-Control", "private, no-store");
    return wrapped;
  };
  try {
    const { limiter } = deps;
    const ip = request.headers.get("CF-Connecting-IP");
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
    const wiring = deps.wiring();
    const endpoint = await timed("resolve", () => wiring.endpoints.resolve(id));
    if (!endpoint) {
      return finish(new Response("Not found.", { status: 404 }));
    }
    ({ name } = endpoint);
    // An endpoint viewer never needs the visitor hash, and the daily salt
    // behind it is a D1 write. Only the access row uses it, after the answer.
    const hostMeta = {
      ipPrefix: prefix,
      place:
        (request as { cf?: { country?: string | null } }).cf?.country || null,
      userAgent: cutUserAgent(request.headers.get("User-Agent")),
      visitorHash: "",
    };
    const started = performance.now();
    const response = await timed("appResponse", () =>
      handleEndpointRequest(request, endpoint, {
        ...wiring,
        applyContentHeaders: finish,
        requestMeta: () => Promise.resolve(hostMeta),
      })
    );
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    const log = Promise.resolve()
      .then(() => wiring.requestMeta(request, endpoint.workspaceId))
      .then((meta) =>
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
      deps.defer?.(log);
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
      deps.timing ? deps.timing.label : "app endpoint timing",
      JSON.stringify({
        appResponse: Math.round(timing.appResponse),
        ...(deps.timing ? { bundle: Math.round(deps.timing.bundle()) } : {}),
        endpoint: name,
        limiter: Math.round(timing.limiter),
        resolve: Math.round(timing.resolve),
        total: Math.round(performance.now() - start),
      })
    );
  }
};
