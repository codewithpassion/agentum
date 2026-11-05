import { WorkerEntrypoint } from "cloudflare:workers";
import { outboundFetch } from "@repo/app-gateway/secrets-outbound-core";
import { compose } from "./compose.ts";

/** Who the isolate's requests are for. Ids only: the entrypoint reads the secrets itself. */
export interface OutboundProps {
  agentId: string;
  runId: string;
  workspaceId: string;
}

/**
 * The `globalOutbound` of a skill script's isolate (`PiRun` makes one with
 * `ctx.exports.SecretsOutbound({ props })`). Every request the script sends
 * arrives here, and `outboundFetch` adds the credentials the agent has rules
 * for. The isolate cannot forge the props: it only holds the stub.
 */
export class SecretsOutbound extends WorkerEntrypoint<Env, OutboundProps> {
  override fetch(request: Request): Promise<Response> {
    const { services } = compose(this.env, import.meta.env.DEV);
    const { agentId, runId, workspaceId } = this.ctx.props;
    return outboundFetch(request, {
      announce: (host, names) =>
        services.secrets.announceInjection(
          { agentId, runId, workspaceId },
          { host, names, via: "outbound" }
        ),
      fetch: (outgoing) => fetch(outgoing),
      log: (line) => console.warn(line),
      matches: (host) => services.secrets.proxyFor(workspaceId, agentId, host),
    });
  }
}
