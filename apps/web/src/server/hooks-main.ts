import { exports, waitUntil } from "cloudflare:workers";
import { defineHooksMain } from "@repo/app-gateway/hooks-rpc";
import { appGatewayPortsOf } from "./app-gateway/wiring.ts";
import { compose } from "./compose.ts";

export const HooksMain = defineHooksMain((env: Env) => ({
  ports: appGatewayPortsOf(env, import.meta.env.DEV, exports),
  recordError: compose(env, import.meta.env.DEV, waitUntil, exports).services
    .artifactErrors.record,
}));
