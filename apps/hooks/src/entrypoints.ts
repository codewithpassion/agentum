import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  HooksMainBinding,
  HostOperation,
} from "../../web/src/server/app-gateway/hooks-rpc.ts";
import type {
  AgentumHost,
  AppHostProps,
  AppOutboundProps,
  AppStartRunInput,
  StorageArea,
} from "../../web/src/server/app-gateway/types.ts";

interface BridgeEnv {
  MAIN: HooksMainBinding;
}

/** Request identity remains in private props; the app cannot choose a different viewer. */
export class HooksHost
  extends WorkerEntrypoint<BridgeEnv, AppHostProps>
  implements AgentumHost
{
  #call<K extends keyof AgentumHost>(
    operation: Extract<HostOperation, { method: K }>
  ): ReturnType<AgentumHost[K]> {
    return this.env.MAIN.host(this.ctx.props, operation) as ReturnType<
      AgentumHost[K]
    >;
  }
  callTool(tool: string, args: unknown) {
    return this.#call<"callTool">({ args: [tool, args], method: "callTool" });
  }
  deleteItem(area: StorageArea, key: string) {
    return this.#call<"deleteItem">({
      args: [area, key],
      method: "deleteItem",
    });
  }
  getItem(area: StorageArea, key: string) {
    return this.#call<"getItem">({ args: [area, key], method: "getItem" });
  }
  listItems(area: StorageArea, prefix?: string, limit?: number) {
    return this.#call<"listItems">({
      args: [area, prefix, limit],
      method: "listItems",
    });
  }
  setItem(area: StorageArea, key: string, value: string) {
    return this.#call<"setItem">({
      args: [area, key, value],
      method: "setItem",
    });
  }
  startRun(input: AppStartRunInput) {
    return this.#call<"startRun">({ args: [input], method: "startRun" });
  }
  whoami() {
    return this.#call<"whoami">({ args: [], method: "whoami" });
  }
}

export class HooksOutbound extends WorkerEntrypoint<
  BridgeEnv,
  AppOutboundProps
> {
  override fetch(request: Request) {
    return this.env.MAIN.outbound(request, this.ctx.props);
  }
}
