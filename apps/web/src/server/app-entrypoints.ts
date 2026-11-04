import { defineAppEntrypoints } from "./app-gateway/entrypoints.ts";
import { type AppGatewayEnv, appGatewayPortsOf } from "./app-gateway/wiring.ts";

/**
 * `AppHost` (the `env.AGENTUM` of an app's server part) and `AppOutbound` (its
 * `globalOutbound`), over the composed services. `server.ts` exports both so
 * `ctx.exports` can reach them.
 */
export const { AppHost, AppOutbound } = defineAppEntrypoints((env: Env) =>
  appGatewayPortsOf(env as AppGatewayEnv, import.meta.env.DEV)
);
