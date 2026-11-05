import { d1Atomic } from "@repo/db/atomic";
import { createArtifactEndpointsService } from "@repo/services/artifacts/endpoints";
import { createHooksSource } from "@repo/services/artifacts/hooks-source";
import { drizzle } from "drizzle-orm/d1";
import { bundleOf } from "../../web/src/server/app-gateway/bundle-source.ts";
import { dynamicAppRuntime } from "../../web/src/server/app-gateway/dynamic-app-runtime.ts";
import { handleEndpointRoute } from "../../web/src/server/app-gateway/endpoint-handler.ts";
import type { HooksMainBinding } from "../../web/src/server/app-gateway/hooks-rpc.ts";

// biome-ignore lint/performance/noBarrelFile: Worker entry must export its RPC classes
export { HooksHost, HooksOutbound } from "./entrypoints.ts";

type FrontEnv = Pick<HooksEnv, "DB" | "FILES" | "LOADER" | "APP_API_LIMIT"> & {
  MAIN: HooksMainBinding;
};
const ENDPOINT_PATH = /^\/hooks\/([^/]+)(?:\/|$)/;

type Stub = (options: { props: unknown }) => unknown;

export default {
  fetch(
    request: Request,
    env: FrontEnv,
    ctx: ExecutionContext
  ): Promise<Response> {
    const db = drizzle(env.DB);
    const clock = { now: () => new Date() };
    const source = createHooksSource({ clock, db });
    const endpoints = createArtifactEndpointsService({
      atomic: d1Atomic(db),
      clock,
      db,
      errors: { list: async () => [] },
    });
    const exported = ctx.exports as unknown as {
      HooksHost: Stub;
      HooksOutbound: Stub;
    };
    let bundleMs = 0;
    const readBundle = bundleOf({ artifactApp: source }, env.FILES);
    const id = ENDPOINT_PATH.exec(new URL(request.url).pathname)?.[1];
    return handleEndpointRoute(request, id ?? "", {
      defer: (work) => ctx.waitUntil(work),
      limiter: env.APP_API_LIMIT,
      timing: { bundle: () => bundleMs, label: "hooks front timing" },
      wiring: () => ({
        declaresHosts: source.declaresHosts,
        defer: (work) => ctx.waitUntil(work),
        endpoints,
        ports: {
          shares: { state: async () => ({ ok: false, reason: "unknown" }) },
          source: {
            bundle: async (artifactId, versionId) => {
              const started = performance.now();
              try {
                return await readBundle(artifactId, versionId);
              } finally {
                bundleMs += performance.now() - started;
              }
            },
          },
        },
        recordError: (target, entry, error) =>
          env.MAIN.recordError(
            target,
            entry,
            error instanceof Error ? error.message : String(error)
          ),
        requestMeta: source.requestMeta,
        runtime: dynamicAppRuntime({
          hostStub: (props) => exported.HooksHost({ props }),
          loader: env.LOADER,
          outboundStub: (props) => exported.HooksOutbound({ props }) as Fetcher,
        }),
      }),
    });
  },
};
