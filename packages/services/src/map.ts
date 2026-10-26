import type { Database } from "@repo/db";
import {
  type GraphAgent,
  type GraphCount,
  graphCounts,
  graphNodes,
  graphOutputs,
} from "@repo/db/map";
import type { MapGraph, MapNode, MapWire } from "@repo/db/shared";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import type { RequestRecord, RequestsService } from "./requests.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

export const mapGraphInputSchema = z.strictObject({ days: z.literal(7) });

export const createMapService = ({
  db,
  clock,
  requests,
}: {
  db: Database;
  clock: Clock;
  requests: Pick<RequestsService, "listPending">;
}) => ({
  async graph(
    principal: Principal,
    raw: z.input<typeof mapGraphInputSchema>
  ): Promise<MapGraph<RequestRecord>> {
    if (principal.kind !== "user") {
      throw new ForbiddenError("map.read");
    }
    authorize(principal, "map.read", {
      kind: "map",
      workspaceId: principal.workspaceId,
    });
    const { days } = mapGraphInputSchema.parse(raw);
    const now = clock.now();
    const [data, counts, outputs, pending] = await Promise.all([
      graphNodes(db, principal.workspaceId),
      graphCounts(
        db,
        principal.workspaceId,
        new Date(now.getTime() - days * 86_400_000).toISOString(),
        now.toISOString()
      ),
      graphOutputs(db, principal.workspaceId),
      requests.listPending(principal),
    ]);
    const nodes = new Map<string, MapNode<RequestRecord>>();
    const columns = { agent: 0, output: 0, trigger: 0 };
    const addNode = (node: Omit<MapNode<RequestRecord>, "x" | "y">) => {
      if (nodes.has(node.key)) {
        return;
      }
      const position = data.positions.find((p) => p.key === node.key);
      const y = columns[node.kind] * 160;
      columns[node.kind] += 1;
      nodes.set(node.key, {
        ...node,
        x: position?.x ?? { agent: 400, output: 800, trigger: 0 }[node.kind],
        y: position?.y ?? y,
      });
    };
    for (const agent of data.agents) {
      addNode(agentNode(agent, data.ports, pending, now.toISOString()));
    }
    const wires = new Map<string, MapWire>();
    const wire = (value: MapWire) => {
      if (!(nodes.has(value.from) && nodes.has(value.to))) {
        return;
      }
      const key = `${value.kind}:${value.from}:${value.to}`;
      const previous = wires.get(key);
      wires.set(key, {
        ...value,
        active: value.active || (previous?.active ?? false),
        count7d: (previous?.count7d ?? 0) + value.count7d,
      });
    };
    for (const trigger of data.triggers) {
      if (!nodes.has(`agent:${trigger.agentId}`)) {
        continue;
      }
      addNode({
        key: `trigger:${trigger.id}`,
        kind: "trigger",
        label: trigger.label,
        ports: [],
        subkind: trigger.kind,
      });
      wire({
        active: false,
        count7d: 0,
        from: `trigger:${trigger.id}`,
        kind: "trigger",
        to: `agent:${trigger.agentId}`,
      });
    }
    // Configured handoffs and persisted output destinations stay visible when idle.
    for (const agent of data.agents) {
      for (const target of JSON.parse(agent.handsTo) as string[]) {
        wire({
          active: false,
          count7d: 0,
          from: `agent:${agent.id}`,
          kind: "handoff",
          to: `agent:${target}`,
        });
      }
    }
    addCounts([...outputs, ...counts], nodes, addNode, wire);
    return { nodes: [...nodes.values()], wires: [...wires.values()] };
  },
});
export type MapService = ReturnType<typeof createMapService>;

const agentNode = (
  agent: GraphAgent,
  assigned: Awaited<ReturnType<typeof graphNodes>>["ports"],
  pending: RequestRecord[],
  now: string
): Omit<MapNode<RequestRecord>, "x" | "y"> => {
  const ports: MapNode["ports"] = assigned
    .filter((p) => p.agentId === agent.id)
    .map(({ agentId: _, ...port }) => port);
  if (agent.computerId) {
    ports.push({
      id: agent.computerId,
      kind: "computer",
      label: "Computer",
      status: agent.computerStatus,
    });
  }
  if (JSON.parse(agent.runtimeConfig).browser !== false) {
    ports.push({ id: agent.id, kind: "browser", label: "Browser" });
  }
  const waitingRuns = JSON.parse(agent.waitingRuns) as string[];
  // Multiple waiting runs use the oldest visible, non-dry pending request.
  const pendingRequest = pending.find(
    (r) => waitingRuns.includes(r.runId) && r.expiresAt > now
  );
  return {
    key: `agent:${agent.id}`,
    kind: "agent",
    label: agent.name,
    pendingRequest,
    ports,
    subkind: null,
    waiting: waitingRuns.length > 0,
  };
};

const outputLabel = (kind: string, key: string): string => {
  if (kind === "qa") {
    return "Q&A";
  }
  if (kind === "email") {
    return "Outbound email";
  }
  return key.split(":").slice(2).join(":");
};

const addCounts = (
  counts: GraphCount[],
  nodes: Map<string, MapNode<RequestRecord>>,
  addNode: (node: Omit<MapNode<RequestRecord>, "x" | "y">) => void,
  wire: (value: MapWire) => void
) => {
  for (const count of counts) {
    if (count.to.startsWith("out:") && nodes.has(count.from)) {
      const subkind =
        count.kind === "trigger" || count.kind === "handoff"
          ? null
          : count.kind;
      addNode({
        key: count.to,
        kind: "output",
        label: outputLabel(count.kind, count.to),
        ports: [],
        subkind,
      });
    }
    wire({ ...count, active: Boolean(count.active) });
  }
};
