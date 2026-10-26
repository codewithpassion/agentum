import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import {
  findMapTrigger,
  type GraphAgent,
  type GraphCount,
  graphCounts,
  graphNodes,
  graphOutputs,
  upsertMapPositions,
} from "@repo/db/map";
import type { MapGraph, MapNode, MapWire } from "@repo/db/shared";
import { z } from "zod";
import type { AgentsService } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import { requireApprover } from "./automation-access.ts";
import type { ConnectorsService } from "./connectors.ts";
import { ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import type { MachinesService } from "./machines.ts";
import type { RequestRecord, RequestsService } from "./requests.ts";
import type { RoutinesService } from "./routines.ts";
import type { Clock } from "./runs/types.ts";
import type { SkillsStoreService } from "./skills-store.ts";
import type { TriggersService } from "./triggers.ts";
import type { Principal } from "./workspaces.ts";

export const mapGraphInputSchema = z.strictObject({ days: z.literal(7) });

const idSchema = z.string().min(1).max(200);
export const mapConnectTriggerSchema = z.strictObject({
  agentId: idSchema,
  triggerId: idSchema,
});
export const mapDisconnectTriggerSchema = z.strictObject({
  triggerId: idSchema,
});
// Tool ids are profile resource ids. Browser has no stored resource id.
export const mapToolSchema = z.discriminatedUnion("kind", [
  z.strictObject({ id: idSchema, kind: z.literal("connector") }),
  z.strictObject({ id: idSchema, kind: z.literal("skill") }),
  z.strictObject({ id: idSchema, kind: z.literal("computer") }),
  z.strictObject({ kind: z.literal("browser") }),
]);
export const mapToolInputSchema = z.strictObject({
  agentId: idSchema,
  tool: mapToolSchema,
});
export const mapPositionsSchema = z
  .array(
    z.strictObject({
      key: z
        .string()
        .max(1024)
        .regex(
          /^(?:agent:[^:\s]+|trigger:(?:slack:)?[^:\s]+|out:slack:[^:\s]+|out:library:\P{Cc}+|out:qa|out:email:[^:\s]+)$/u
        ),
      x: z.number(),
      y: z.number(),
    })
  )
  .max(500);
type MapTool = z.input<typeof mapToolSchema>;

export const createMapService = ({
  db,
  atomic,
  clock,
  requests,
  agents,
  triggers,
  routines,
  connectors,
  skillsStore,
  machines,
  events,
}: {
  agents: Pick<AgentsService, "get" | "update">;
  triggers: Pick<TriggersService, "reassign" | "revoke">;
  routines: Pick<RoutinesService, "remove">;
  connectors: Pick<ConnectorsService, "assign" | "unassign">;
  skillsStore: Pick<SkillsStoreService, "assign" | "unassign">;
  machines: Pick<MachinesService, "attachComputer">;
  events: Pick<EventsService, "append">;
  atomic: Atomic;
  db: Database;
  clock: Clock;
  requests: Pick<RequestsService, "listPending">;
}) => {
  const writer = (principal: Principal) => {
    const user = requireApprover(principal, "map.edit");
    authorize(user, "map.edit", { kind: "map", workspaceId: user.workspaceId });
    return user;
  };
  const edited = async (
    principal: Principal,
    payload: Record<string, unknown>
  ) => {
    const user = writer(principal);
    await events.append({
      actor: { id: user.userId, kind: "user" },
      payload,
      type: "map.edited",
      workspaceId: user.workspaceId,
    });
  };
  const changeComputer = async (
    principal: Principal,
    agentId: string,
    machineId: string,
    plug: boolean
  ) => {
    if (!plug) {
      const agent = await agents.get(principal, agentId);
      if (agent.computerMachineId !== machineId) {
        throw new ServiceError("invalid", "That computer is not plugged in");
      }
    }
    await machines.attachComputer(principal, agentId, plug ? machineId : null);
  };
  const changeBrowser = async (
    principal: Principal,
    agentId: string,
    plug: boolean
  ) => {
    const agent = await agents.get(principal, agentId);
    const { browser: _, ...enabledConfig } = agent.runtimeConfig;
    // Missing browser means on, matching V6's run capabilities.
    const runtimeConfig = plug
      ? enabledConfig
      : { ...enabledConfig, browser: false };
    await agents.update(principal, agentId, { runtimeConfig });
  };
  const toolChange = async (
    principal: Principal,
    agentId: string,
    raw: MapTool,
    plug: boolean
  ) => {
    writer(principal);
    const { tool } = mapToolInputSchema.parse({ agentId, tool: raw });
    const assignment = plug ? "assign" : "unassign";
    if (tool.kind === "connector") {
      await connectors[assignment](principal, {
        agentId,
        connectorId: tool.id,
      });
    } else if (tool.kind === "skill") {
      await skillsStore[assignment](principal, {
        agentId,
        skillId: tool.id,
      });
    } else if (tool.kind === "computer") {
      await changeComputer(principal, agentId, tool.id, plug);
    } else {
      await changeBrowser(principal, agentId, plug);
    }
    await edited(principal, {
      action: plug ? "plugTool" : "unplugTool",
      agentId,
      tool,
    });
  };
  return {
    async connectTrigger(
      principal: Principal,
      triggerId: string,
      agentId: string
    ) {
      writer(principal);
      mapConnectTriggerSchema.parse({ agentId, triggerId });
      await triggers.reassign(principal, triggerId, agentId);
      await edited(principal, { action: "connectTrigger", agentId, triggerId });
    },
    async disconnectTrigger(principal: Principal, triggerId: string) {
      const user = writer(principal);
      mapDisconnectTriggerSchema.parse({ triggerId });
      const trigger = await findMapTrigger(db, user.workspaceId, triggerId);
      if (!trigger) {
        throw new ServiceError("not_found", "Trigger not found");
      }
      if (trigger.kind === "routine") {
        await routines.remove(principal, triggerId);
      } else {
        await triggers.revoke(principal, triggerId);
      }
      await edited(principal, { action: "disconnectTrigger", triggerId });
    },
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
    async plugTool(principal: Principal, agentId: string, tool: MapTool) {
      await toolChange(principal, agentId, tool, true);
    },
    async savePositions(
      principal: Principal,
      raw: z.input<typeof mapPositionsSchema>
    ) {
      const user = writer(principal);
      const positions = mapPositionsSchema.parse(raw);
      await upsertMapPositions(
        db,
        atomic,
        user.workspaceId,
        positions,
        clock.now().toISOString()
      );
      await edited(principal, {
        action: "savePositions",
        count: positions.length,
      });
    },
    async unplugTool(principal: Principal, agentId: string, tool: MapTool) {
      await toolChange(principal, agentId, tool, false);
    },
  };
};
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
