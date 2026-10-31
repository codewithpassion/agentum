// The peer side of `list_agents`, `send_message` and `get_run`: agents outside
// the workspace, reached through an agent connection. Only a run reaches them,
// because a connection belongs to one agent. The outbound service decides the
// rest: the policy, the approval card, the hourly limit and the audit events.
import type { AgentInfo, RunInfo } from "@repo/mcp/ports";
import { SEND_WAIT_MAX_MS } from "@repo/mcp/ports";
import { ToolError } from "@repo/mcp/result";
import type { OutboundTaskInfo } from "@repo/services/a2a/outbound";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose.ts";
import { guarded } from "./guarded.ts";

/** Ids of the tasks `send` makes. A local run id never starts with this. */
const PEER_TASK_PREFIX = "aot_";
const POLL_MS = 500;
const FINISHED = ["done", "failed", "cancelled"];

const toRunInfo = (task: OutboundTaskInfo): RunInfo => ({
  agentId: task.agentId,
  answer: task.answer,
  error: task.error,
  runId: task.runId,
  sessionId: task.sessionId,
  status: task.status,
  statusText: task.statusText,
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createPeerPorts = ({
  principal,
  services,
}: {
  principal: Principal;
  services: Pick<Services, "a2aOutbound">;
}) => {
  const { a2aOutbound } = services;

  /** Polls the task until it finishes or `waitMs` passes, like `waitForRun` does for a local run. */
  const waitFor = async (
    taskId: string,
    waitMs: number
  ): Promise<OutboundTaskInfo> => {
    const deadline =
      Date.now() + Math.min(Math.max(waitMs, 0), SEND_WAIT_MAX_MS);
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: polling is sequential by nature
      const task = await a2aOutbound.get(principal, taskId);
      const remaining = deadline - Date.now();
      if (FINISHED.includes(task.status) || remaining <= 0) {
        return task;
      }
      await sleep(Math.min(POLL_MS, remaining));
    }
  };

  return {
    getRun: (taskId: string): Promise<RunInfo> =>
      guarded(async () => toRunInfo(await a2aOutbound.get(principal, taskId))),

    list: (): Promise<AgentInfo[]> =>
      guarded(async () =>
        (await a2aOutbound.listPeers(principal)).map((peer) => ({
          description: peer.description,
          host: peer.host,
          id: peer.connectionId,
          name: peer.name,
          peer: true as const,
          slug: peer.slug,
        }))
      ),

    /** Whether `agent` names a peer. A local slug has no slash, so it never does. */
    ownsAgent: (agent: string): boolean =>
      principal.kind === "run" && agent.includes("/"),
    /** Whether `runId` names a message to a peer. */
    ownsRun: (runId: string): boolean =>
      principal.kind === "run" && runId.startsWith(PEER_TASK_PREFIX),

    send: ({
      agent,
      requestId,
      text,
      waitMs,
    }: {
      agent: string;
      requestId?: string;
      text: string;
      waitMs: number;
    }): Promise<RunInfo> =>
      guarded(async () => {
        const [connection = "", peerAgent = ""] = agent.split("/", 2);
        // A slug that names a live peer must name it whole. One that is gone
        // (revoked, switched off) goes on to the service, which says why.
        const known = (await a2aOutbound.listPeers(principal)).find(
          (peer) =>
            peer.slug.split("/", 1)[0] === connection ||
            peer.connectionId === connection
        );
        if ((known && known.slug !== agent) || !(connection && peerAgent)) {
          throw new ToolError(
            "not_found",
            `No agent "${agent}". Call list_agents for the names you can use.`
          );
        }
        const sent = await a2aOutbound.send(principal, {
          connection,
          requestId: requestId ?? crypto.randomUUID(),
          text,
        });
        return toRunInfo(waitMs > 0 ? await waitFor(sent.runId, waitMs) : sent);
      }),
  };
};
