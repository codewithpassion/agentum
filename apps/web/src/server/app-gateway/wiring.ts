/**
 * Builds what the app gateway needs for one request, or for one `AppHost` /
 * `AppOutbound` call, from the Worker's bindings. The only place the gateway
 * meets `compose`.
 */

import { waitUntil } from "cloudflare:workers";
import type { ArtifactEndpointsService } from "@repo/services/artifacts/endpoints";
import { appStorePort } from "../app-store/port.ts";
import { type ComposeEnv, compose } from "../compose.ts";
import { createAppGatewayPorts } from "./compose-ports.ts";
import { dynamicAppRuntime } from "./dynamic-app-runtime.ts";
import type { AppGatewayWiring } from "./mount.ts";
import type { AppGatewayPorts } from "./ports.ts";
import type { AppWorkerExports } from "./reply-invoker.ts";

export type AppGatewayEnv = ComposeEnv & Pick<Env, "APP_STORE" | "LOADER">;

const portsByEnv = new WeakMap<object, AppGatewayPorts>();

/**
 * The ports for `defineAppEntrypoints`: deferred work uses the current RPC execution context.
 * Kept per `env`, because every storage call of an app comes through here.
 */
export const appGatewayPortsOf = (
  env: AppGatewayEnv,
  dev: boolean,
  exports?: AppWorkerExports
): AppGatewayPorts => {
  const known = portsByEnv.get(env);
  if (known) {
    return known;
  }
  const { services } = compose(env, dev, waitUntil, exports);
  const ports = createAppGatewayPorts({
    bucket: env.FILES,
    services,
    store: appStorePort(env.APP_STORE),
  });
  portsByEnv.set(env, ports);
  return ports;
};

type Stub = (options: { props: unknown }) => unknown;

/** The slice of the Worker's execution context the gateway uses (Hono's type for it is narrower than workerd's). */
interface GatewayContext {
  waitUntil: (work: Promise<unknown>) => void;
}

/** The `ctx.exports` of the Worker's execution context. */
const exportsOf = (ctx: GatewayContext) =>
  (ctx as unknown as { exports: { AppHost: Stub; AppOutbound: Stub } }).exports;

export const appGatewayWiring = (
  env: AppGatewayEnv,
  ctx: GatewayContext,
  dev: boolean
): AppGatewayWiring & { endpoints: ArtifactEndpointsService } => {
  const { services } = compose(
    env,
    dev,
    (work) => ctx.waitUntil(work),
    exportsOf(ctx)
  );
  const ports = createAppGatewayPorts({
    bucket: env.FILES,
    services,
    store: appStorePort(env.APP_STORE),
  });
  const exported = exportsOf(ctx);
  return {
    declaresHosts: (versionId) => services.artifactApp.declaresHosts(versionId),
    endpoints: services.artifactEndpoints,
    ports,
    requestMeta: async (request, workspaceId) => {
      const meta = await services.artifactShares.visitorMeta(workspaceId, {
        cf: (request as { cf?: { country?: string | null } }).cf ?? null,
        ip: request.headers.get("CF-Connecting-IP"),
        userAgent: request.headers.get("User-Agent"),
      });
      return {
        ipPrefix: meta.ipPrefix,
        place: meta.place,
        userAgent: meta.userAgent,
        // No address means one shared bucket; the port reads "" as null.
        visitorHash: meta.visitorHash ?? "",
      };
    },
    runtime: dynamicAppRuntime({
      hostStub: (props) => exported.AppHost({ props }),
      loader: env.LOADER,
      outboundStub: (props) =>
        exported.AppOutbound({ props }) as unknown as Fetcher,
    }),
  };
};
