import type {
  AgentRuntime,
  MapGraph,
  MapNode,
  MapNodeKind,
  MapOutputKind,
  MapTriggerKind,
  MapWire,
  MapWireKind,
} from "@repo/db/shared";
import { MarkerType } from "@xyflow/react";
import { isDeletableWire } from "./editor-logic.ts";
import {
  type AgentFlowNode,
  type MapFlowEdge,
  type MapFlowNode,
  type OutputFlowNode,
  type TileStatus,
  type TileTone,
  type TriggerFlowNode,
  WIRE_COLOR,
} from "./map-types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const HASH_MODULUS = 2 ** 32;
const TONES = 4;
const WHITESPACE = /\s+/;

export const NODE_SIZE: Record<MapNodeKind, { height: number; width: number }> =
  {
    agent: { height: 76, width: 200 },
    output: { height: 60, width: 170 },
    trigger: { height: 60, width: 150 },
  };

const AGENT_KEY_PREFIX = "agent:";

/** The agent id in an `agent:<id>` node key, or null for any other key. */
export function agentIdOf(key: string): string | null {
  return key.startsWith(AGENT_KEY_PREFIX)
    ? key.slice(AGENT_KEY_PREFIX.length)
    : null;
}

/**
 * The ports an agent node can show as chips: browser ports first, then the
 * rest in their own order. `hidden` counts the ports that did not fit in `max`.
 */
export function visiblePorts<T extends { kind: string }>(
  ports: readonly T[],
  max: number
): { hidden: number; shown: T[] } {
  const ordered = [
    ...ports.filter((port) => port.kind === "browser"),
    ...ports.filter((port) => port.kind !== "browser"),
  ];
  const shown = ordered.slice(0, Math.max(0, max));
  return { hidden: ordered.length - shown.length, shown };
}

const RUNTIME_SHORT: Record<AgentRuntime, string> = {
  cloud: "Cloudflare",
  fake: "Test runner",
  machine: "Our machine",
  managed: "Anthropic cloud",
};

export function runtimeShort(runtime: AgentRuntime): string {
  return RUNTIME_SHORT[runtime];
}

/** Runs per agent whose `createdAt` falls in the last `days` days up to `nowMs`. */
export function runCountsByAgent(
  tasks: { agentId: string; createdAt: string }[],
  nowMs: number,
  days = 7
): Map<string, number> {
  const cutoff = nowMs - days * DAY_MS;
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const at = Date.parse(task.createdAt);
    if (Number.isNaN(at) || at < cutoff || at > nowMs) {
      continue;
    }
    counts.set(task.agentId, (counts.get(task.agentId) ?? 0) + 1);
  }
  return counts;
}

/** Singular and plural nouns for each wire kind. */
const WIRE_NOUNS: Record<MapWireKind, [singular: string, plural: string]> = {
  email: ["email", "emails"],
  handoff: ["handoff", "handoffs"],
  library: ["write", "writes"],
  qa: ["question", "questions"],
  slack: ["message", "messages"],
  trigger: ["run", "runs"],
};

export function wireLabel(wire: {
  count7d: number;
  kind: MapWireKind;
}): string {
  const [singular, plural] = WIRE_NOUNS[wire.kind];
  return `${wire.count7d} ${wire.count7d === 1 ? singular : plural}`;
}

function hashOf(text: string): number {
  return Array.from(text, (char) => char.charCodeAt(0)).reduce(
    (hash, code) => (hash * 31 + code) % HASH_MODULUS,
    0
  );
}

/** A stable tile colour, 1 to 4, for a node key. */
export function toneOf(key: string): TileTone {
  return ((hashOf(key) % TONES) + 1) as TileTone;
}

/** Up to two uppercase letters: the first letters of two words, or the start of one word. */
export function initialsOf(label: string): string {
  const words = label
    .trim()
    .split(WHITESPACE)
    .filter((word) => word.length > 0);
  const letters =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => word.charAt(0))
          .join("")
      : (words[0] ?? "").slice(0, 2);
  return letters.length > 0 ? letters.toUpperCase() : "?";
}

/**
 * Where a wire leaves and arrives. Handoffs between agents run vertically,
 * from the lower edge of the upper agent to the upper edge of the lower one,
 * so two agents in one column do not loop sideways. Every other wire runs
 * from a right edge to a left edge.
 */
function handlesOf(
  wire: MapWire,
  nodes: Map<string, { y: number }>
): { sourceHandle: string; targetHandle: string } {
  if (wire.kind !== "handoff") {
    return { sourceHandle: "right", targetHandle: "left" };
  }
  const from = nodes.get(wire.from)?.y ?? 0;
  const to = nodes.get(wire.to)?.y ?? 0;
  if (to === from) {
    return { sourceHandle: "right", targetHandle: "left" };
  }
  // The upper edge has a source handle too, and the lower edge a target one.
  return to > from
    ? { sourceHandle: "bottom", targetHandle: "top" }
    : { sourceHandle: "top-out", targetHandle: "bottom-in" };
}

export function toFlowEdges(
  graph: MapGraph<unknown>,
  editor = false
): MapFlowEdge[] {
  const nodes = new Map(graph.nodes.map((node) => [node.key, node] as const));
  return graph.wires.map((wire) => {
    const carried = wire.active || wire.count7d > 0;
    const deletable = editor && isDeletableWire(graph, wire);
    return {
      animated: wire.active,
      data: { active: wire.active, carried, deletable, kind: wire.kind },
      id: `${wire.kind}:${wire.from}:${wire.to}`,
      label: wireLabel(wire),
      markerEnd: {
        color: carried ? WIRE_COLOR.carried : WIRE_COLOR.idle,
        type: MarkerType.ArrowClosed,
      },
      source: wire.from,
      target: wire.to,
      type: "count",
      ...handlesOf(wire, nodes),
    };
  });
}

export interface FlowNodeContext {
  agents: Map<string, { runtime: AgentRuntime }>;
  /** Editor mode: nodes drag and the ends of a wire connect. */
  editor?: boolean;
  qaOpenCount: number;
  runCounts: Map<string, number>;
  selectedKey: string | null;
}

function runsText(runs: number): string {
  return `${runs} ${runs === 1 ? "run" : "runs"}`;
}

function agentStatus(
  node: MapNode<unknown>,
  wires: MapWire[],
  runCounts: Map<string, number>
): TileStatus {
  if (node.waiting) {
    return "waiting";
  }
  if (wires.some((wire) => wire.active && wire.to === node.key)) {
    return "running";
  }
  const agentId = agentIdOf(node.key);
  if (agentId !== null && (runCounts.get(agentId) ?? 0) > 0) {
    return "ok";
  }
  return "idle";
}

function agentStatusText(
  node: MapNode<unknown>,
  ctx: FlowNodeContext,
  status: TileStatus
): string {
  if (status === "waiting") {
    return "Paused, needs you";
  }
  const agentId = agentIdOf(node.key);
  const runs = agentId === null ? 0 : (ctx.runCounts.get(agentId) ?? 0);
  const agent = agentId === null ? undefined : ctx.agents.get(agentId);
  const runtime = agent ? ` · ${runtimeShort(agent.runtime)}` : "";
  return `${runsText(runs)}${runtime}`;
}

function agentNode(
  node: MapNode<unknown>,
  wires: MapWire[],
  ctx: FlowNodeContext
): AgentFlowNode {
  const status = agentStatus(node, wires, ctx.runCounts);
  return {
    id: node.key,
    position: { x: node.x, y: node.y },
    type: "agent",
    ...NODE_SIZE.agent,
    connectable: ctx.editor === true,
    data: {
      initials: initialsOf(node.label),
      label: node.label,
      ports: node.ports.map((port) => ({
        id: port.id,
        kind: port.kind,
        label: port.label,
      })),
      status,
      statusText: agentStatusText(node, ctx, status),
      tone: toneOf(node.key),
    },
    deletable: false,
    draggable: ctx.editor === true,
    selected: node.key === ctx.selectedKey,
  };
}

function triggerNode(
  node: MapNode<unknown>,
  wires: MapWire[],
  ctx: FlowNodeContext
): TriggerFlowNode {
  return {
    id: node.key,
    position: { x: node.x, y: node.y },
    type: "trigger",
    ...NODE_SIZE.trigger,
    connectable: ctx.editor === true,
    data: {
      active: wires.some((wire) => wire.from === node.key && wire.active),
      detail: "",
      label: node.label,
      subkind: (node.subkind ?? "http") as MapTriggerKind,
      tone: toneOf(node.key),
    },
    deletable: false,
    draggable: ctx.editor === true,
    selected: node.key === ctx.selectedKey,
  };
}

function outputNode(
  node: MapNode<unknown>,
  wires: MapWire[],
  ctx: FlowNodeContext
): OutputFlowNode {
  const subkind = (node.subkind ?? "library") as MapOutputKind;
  const count7d = wires
    .filter((wire) => wire.to === node.key)
    .reduce((sum, wire) => sum + wire.count7d, 0);
  return {
    id: node.key,
    position: { x: node.x, y: node.y },
    type: "output",
    ...NODE_SIZE.output,
    connectable: ctx.editor === true,
    data: {
      detail:
        subkind === "qa"
          ? `${ctx.qaOpenCount} open`
          : wireLabel({ count7d, kind: subkind }),
      label: node.label,
      subkind,
      tone: toneOf(node.key),
    },
    deletable: false,
    draggable: ctx.editor === true,
    selected: node.key === ctx.selectedKey,
  };
}

export function toFlowNodes<T>(
  graph: MapGraph<T>,
  ctx: FlowNodeContext
): MapFlowNode[] {
  return graph.nodes.map((node) => {
    switch (node.kind) {
      case "agent":
        return agentNode(node, graph.wires, ctx);
      case "trigger":
        return triggerNode(node, graph.wires, ctx);
      case "output":
        return outputNode(node, graph.wires, ctx);
      default:
        throw new Error(`Unknown map node kind: ${String(node.kind)}`);
    }
  });
}
