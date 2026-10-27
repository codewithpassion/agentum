import { WorkerEntrypoint } from "cloudflare:workers";
import { createAppHost } from "./app-host-core.ts";
import { appOutboundFetch } from "./app-outbound-core.ts";
import type { AppGatewayPorts } from "./ports.ts";
import type {
  AppHostProps,
  AppOutboundProps,
  HM,
  StorageArea,
} from "./types.ts";

/**
 * The two entrypoints a Dynamic Worker reaches through `ctx.exports`, built
 * over one set of ports (B.8 gives them `compose`'s, a test gives fakes):
 * `AppHost` is the `HM` stub of one request, `AppOutbound` is the loaded
 * Worker's `globalOutbound`. The Worker's entry module exports both under
 * these names. The app holds only a stub, so it cannot read the props, and
 * every public method of `AppHost` is callable by the app: helpers stay
 * `#private`. `AppOutbound` has no `connect`, so sockets are refused.
 */
export const defineAppEntrypoints = (
  portsOf: (env: Env) => AppGatewayPorts
) => {
  class AppHost extends WorkerEntrypoint<Env, AppHostProps> implements HM {
    #host(): HM {
      return createAppHost(this.ctx.props, portsOf(this.env));
    }

    callTool(toolKey: string, args: unknown): Promise<unknown> {
      return this.#host().callTool(toolKey, args);
    }

    deleteItem(area: StorageArea, key: string): Promise<void> {
      return this.#host().deleteItem(area, key);
    }

    getItem(area: StorageArea, key: string): Promise<string | null> {
      return this.#host().getItem(area, key);
    }

    listItems(
      area: StorageArea,
      prefix?: string,
      limit?: number
    ): Promise<{ key: string; value: string }[]> {
      return this.#host().listItems(area, prefix, limit);
    }

    setItem(area: StorageArea, key: string, value: string): Promise<void> {
      return this.#host().setItem(area, key, value);
    }

    whoami(): ReturnType<HM["whoami"]> {
      return this.#host().whoami();
    }
  }

  class AppOutbound extends WorkerEntrypoint<Env, AppOutboundProps> {
    override fetch(request: Request): Promise<Response> {
      return appOutboundFetch(request, this.ctx.props, {
        fetch: (outgoing) => fetch(outgoing),
        grants: portsOf(this.env).grants,
        log: (line) => console.warn(line),
      });
    }
  }

  return { AppHost, AppOutbound };
};
