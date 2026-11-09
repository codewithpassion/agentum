import type { Services } from "../compose.ts";
import type { WebFetcher } from "./types.ts";
import { createWebFetcher } from "./web-fetch.ts";

export interface RunFetcherDeps {
  fetch?: (request: Request) => Promise<Response>;
  ownHosts: readonly string[];
  run: { agentId: string; runId: string; workspaceId: string };
  services: Pick<Services, "network" | "secrets">;
  via: "curl" | "run_script" | "web_fetch";
}

/** The one place a run's fetcher is made, shared by the `web_fetch` tool and `curl`. */
export const runWebFetcher = ({
  fetch: send = (request) => globalThis.fetch(request),
  ownHosts,
  run,
  services,
  via,
}: RunFetcherDeps): WebFetcher =>
  createWebFetcher({
    announce: (host, names) =>
      services.secrets.announceInjection(run, { host, names, via }),
    envGrants: () =>
      services.secrets.envGrantsFor(run.workspaceId, run.agentId, run.runId),
    fetch: send,
    log: (line) => console.warn(line),
    matches: (host) =>
      services.secrets.proxyFor(run.workspaceId, run.agentId, host, run.runId),
    ownHosts,
    record: (entry) => services.network.recordRequest(run, entry),
    via,
  });
