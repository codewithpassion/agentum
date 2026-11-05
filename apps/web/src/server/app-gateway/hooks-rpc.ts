import { WorkerEntrypoint } from "cloudflare:workers";
import { createAppHost } from "./app-host-core.ts";
import { appOutboundFetch } from "./app-outbound-core.ts";
import type { AppGatewayPorts } from "./ports.ts";
import type { AgentumHost, AppHostProps, AppOutboundProps } from "./types.ts";

type HostMethod = keyof AgentumHost;
export type HostOperation = {
  [K in HostMethod]: { method: K; args: Parameters<AgentumHost[K]> };
}[HostMethod];

/** Only the trusted hooks service binding receives this entrypoint. No HTTP API. */
export const defineHooksMain = (
  wiring: (env: Env) => {
    ports: AppGatewayPorts;
    recordError: (
      target: AppOutboundProps,
      entry: string,
      error: unknown
    ) => Promise<void>;
  }
) => {
  class HooksMain extends WorkerEntrypoint<Env> {
    override fetch() {
      return Promise.resolve(new Response("Not found.", { status: 404 }));
    }

    async host(
      props: AppHostProps,
      operation: HostOperation
    ): Promise<unknown> {
      // The front supplies identity; untrusted app code receives only a bound stub.
      const host = createAppHost(props, wiring(this.env).ports);
      switch (operation.method) {
        case "callTool":
          return await host.callTool(...operation.args);
        case "deleteItem":
          return await host.deleteItem(...operation.args);
        case "getItem":
          return await host.getItem(...operation.args);
        case "listItems":
          return await host.listItems(...operation.args);
        case "setItem":
          return await host.setItem(...operation.args);
        case "startRun":
          return await host.startRun(...operation.args);
        case "whoami":
          return await host.whoami();
        default:
          throw new Error("Unknown app operation");
      }
    }

    outbound(request: Request, props: AppOutboundProps): Promise<Response> {
      return appOutboundFetch(request, props, {
        fetch: (outgoing) => fetch(outgoing),
        grants: wiring(this.env).ports.grants,
        log: (line) => console.warn(line),
      });
    }

    recordError(target: AppOutboundProps, entry: string, message: string) {
      return wiring(this.env).recordError(target, entry, new Error(message));
    }
  }
  return HooksMain;
};

export interface HooksMainBinding {
  host: (props: AppHostProps, operation: HostOperation) => Promise<unknown>;
  outbound: (request: Request, props: AppOutboundProps) => Promise<Response>;
  recordError: (
    target: AppOutboundProps,
    entry: string,
    message: string
  ) => Promise<void>;
}
