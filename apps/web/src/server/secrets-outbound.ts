import { WorkerEntrypoint } from "cloudflare:workers";

export interface OutboundProps {
  agentId: string;
  runId: string;
  workspaceId: string;
}

export class SecretsOutbound extends WorkerEntrypoint<Env, OutboundProps> {
  override fetch(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set("x-spike-added", `props:${this.ctx.props.runId}`);
    return fetch(new Request(request, { headers, redirect: "manual" }));
  }
}
