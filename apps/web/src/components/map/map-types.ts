import type {
  MapOutputKind,
  MapPortKind,
  MapTriggerKind,
  MapWireKind,
} from "@repo/db/shared";
import type { Edge, Node } from "@xyflow/react";

/** How an agent tile reads: waiting is yellow, running and ok are green, idle is grey. */
export type TileStatus = "idle" | "ok" | "running" | "waiting";

/** One of the four chart tokens that read on a tile (the fifth is near white), which colours a node's tile. */
export type TileTone = 1 | 2 | 3 | 4;

export interface MapPortData {
  kind: MapPortKind;
  label: string;
}

export interface TriggerNodeData extends Record<string, unknown> {
  /** True while a run is going over a wire out of this node. */
  active: boolean;
  /** The line under the name, such as "triage@" or the cron text. */
  detail: string;
  label: string;
  subkind: MapTriggerKind;
  tone: TileTone;
}

export interface AgentNodeData extends Record<string, unknown> {
  initials: string;
  label: string;
  ports: MapPortData[];
  status: TileStatus;
  /** "31 runs · Anthropic cloud", or "Paused, needs you" when waiting. */
  statusText: string;
  tone: TileTone;
}

export interface OutputNodeData extends Record<string, unknown> {
  /** The line under the name, such as "14 files" or "3 questions". */
  detail: string;
  label: string;
  subkind: MapOutputKind;
  tone: TileTone;
}

export type TriggerFlowNode = Node<TriggerNodeData, "trigger">;
export type AgentFlowNode = Node<AgentNodeData, "agent">;
export type OutputFlowNode = Node<OutputNodeData, "output">;
export type MapFlowNode = TriggerFlowNode | AgentFlowNode | OutputFlowNode;

export interface MapEdgeData extends Record<string, unknown> {
  active: boolean;
  /** True when the wire carried work in the window, so it draws green. */
  carried: boolean;
  kind: MapWireKind;
}
export type MapFlowEdge = Edge<MapEdgeData, "count">;
