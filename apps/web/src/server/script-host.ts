import { WorkerEntrypoint } from "cloudflare:workers";
import type { Principal } from "@repo/services/workspaces";
import { compose } from "./compose.ts";
import { bindLibraryOps } from "./library-env/library-ops.ts";
import type {
  HostEntry,
  HostFetchRequest,
  HostFetchResult,
  ScriptHostApi,
} from "./skill-scripts/script-host-api.ts";
import { createScriptHost } from "./skill-scripts/script-host-core.ts";
import { ownHostsOf } from "./web-fetch/guard.ts";
import { runWebFetcher } from "./web-fetch/run-fetcher.ts";

/** What a run_script isolate may do: its home folder, whether it may use the network, and who is asking. */
export interface ScriptHostProps {
  home: string;
  network: boolean;
  run: { agentId: string; runId: string; workspaceId: string };
}

/**
 * The `HOST` binding of a run_script isolate, made with
 * `ctx.exports.ScriptHost({ props })`. Each call builds the host from the props
 * and delegates to `createScriptHost`. The isolate can't read the props, so it
 * only holds the stub, the same as `SecretsOutbound`.
 */
export class ScriptHost
  extends WorkerEntrypoint<Env, ScriptHostProps>
  implements ScriptHostApi
{
  #host(): ScriptHostApi {
    // A library write from a script announces itself after the write returns.
    const { services } = compose(
      this.env,
      import.meta.env.DEV,
      (work) => this.ctx.waitUntil(work),
      this.ctx.exports
    );
    const { home, network, run } = this.ctx.props;
    const principal: Principal = {
      agentId: run.agentId,
      kind: "run",
      runId: run.runId,
      workspaceId: run.workspaceId,
    };
    return createScriptHost({
      fetcher: network
        ? runWebFetcher({
            ownHosts: ownHostsOf(this.env.PUBLIC_BASE_URL),
            run,
            services,
            via: "run_script",
          })
        : undefined,
      home,
      ops: bindLibraryOps(services.library, principal),
    });
  }

  list(dir: string): Promise<HostEntry[]> {
    return this.#host().list(dir);
  }

  read(path: string): Promise<Uint8Array> {
    return this.#host().read(path);
  }

  send(request: HostFetchRequest): Promise<HostFetchResult> {
    return this.#host().send(request);
  }

  write(path: string, bytes: Uint8Array): Promise<void> {
    return this.#host().write(path, bytes);
  }
}
