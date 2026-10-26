// The logic behind the map editor (V7.5): drag payloads, which trigger wires
// may be made, the words in the confirm dialogs, the palette, and which node
// positions to save. Pure: the editor components draw and call these.

import { z } from "zod";
import { computersOf } from "#/components/machines/machine-logic.ts";
import type { MachineRecord } from "#/integrations/trpc/types";

export type MapTool =
  | { kind: "connector" | "skill" | "computer"; id: string }
  | { kind: "browser" };

export const TOOL_MIME = "application/x-harbourmaster-tool";
export const NEW_NODE_MIME = "application/x-harbourmaster-new-node";

const toolSchema = z.union([
  z.object({
    id: z.string().min(1),
    kind: z.enum(["connector", "skill", "computer"]),
  }),
  z.object({ kind: z.literal("browser") }),
]);

const newNodeSchema = z.object({ kind: z.enum(["trigger", "agent"]) });

export type NewNodeKind = z.infer<typeof newNodeSchema>["kind"];

export function encodeTool(tool: MapTool): string {
  return JSON.stringify(tool);
}

/** The tool in a drag payload, or null when the payload is not a tool. */
export function decodeTool(raw: string): MapTool | null {
  const parsed = parseJson(raw);
  const result = toolSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function encodeNewNode(kind: NewNodeKind): string {
  return JSON.stringify({ kind });
}

/** The kind of a node dragged from the palette, or null for any other payload. */
export function decodeNewNode(raw: string): NewNodeKind | null {
  const result = newNodeSchema.safeParse(parseJson(raw));
  return result.success ? result.data.kind : null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function toolOfPort(port: {
  id: string;
  kind: "connector" | "skill" | "computer" | "browser";
}): MapTool {
  return port.kind === "browser"
    ? { kind: "browser" }
    : { id: port.id, kind: port.kind };
}

export function toolKey(tool: MapTool): string {
  return tool.kind === "browser" ? "browser" : `${tool.kind}:${tool.id}`;
}

/** Only an HTTP trigger and a routine can be wired to an agent by hand. */
export function isMovableTrigger(subkind: string | null): boolean {
  return subkind === "http" || subkind === "routine";
}

const TRIGGER_PREFIX = "trigger:";
const SLACK_PREFIX = "slack:";

/** The id in a `trigger:<id>` key, or null for other keys and for Slack triggers. */
export function triggerIdOfKey(key: string): string | null {
  if (!key.startsWith(TRIGGER_PREFIX)) {
    return null;
  }
  const id = key.slice(TRIGGER_PREFIX.length);
  if (id.length === 0 || id.startsWith(SLACK_PREFIX)) {
    return null;
  }
  return id;
}

export interface EditGraph {
  nodes: { key: string; kind: string; label: string; subkind: string | null }[];
  wires: { configured: boolean; from: string; to: string; kind: string }[];
}

type EditNode = EditGraph["nodes"][number];

function nodeOf(graph: EditGraph, key: string): EditNode | undefined {
  return graph.nodes.find((node) => node.key === key);
}

function labelOf(graph: EditGraph, key: string): string {
  return nodeOf(graph, key)?.label ?? key;
}

function isMovableTriggerNode(node: EditNode | undefined): boolean {
  return (
    node !== undefined &&
    node.kind === "trigger" &&
    isMovableTrigger(node.subkind)
  );
}

/** A trigger may start an agent it is not configured to start. A historical wire does not count. */
export function isValidTriggerConnection(
  graph: EditGraph,
  sourceKey: string,
  targetKey: string
): boolean {
  const target = nodeOf(graph, targetKey);
  if (
    !isMovableTriggerNode(nodeOf(graph, sourceKey)) ||
    target === undefined ||
    target.kind !== "agent"
  ) {
    return false;
  }
  return !graph.wires.some(
    (wire) =>
      wire.configured &&
      wire.kind === "trigger" &&
      wire.from === sourceKey &&
      wire.to === targetKey
  );
}

/**
 * The confirm text for wiring a trigger to an agent. A trigger starts one
 * agent, so a trigger that already starts another agent moves its wire.
 */
export function moveWireMessage(
  graph: EditGraph,
  sourceKey: string,
  targetKey: string
): { body: string; title: string } {
  const trigger = labelOf(graph, sourceKey);
  const target = labelOf(graph, targetKey);
  const previous = graph.wires.find(
    (wire) =>
      wire.configured &&
      wire.kind === "trigger" &&
      wire.from === sourceKey &&
      wire.to !== targetKey
  );
  if (previous === undefined) {
    return {
      body: `Connect "${trigger}" to ${target}?`,
      title: "Connect this trigger?",
    };
  }
  const old = labelOf(graph, previous.to);
  return {
    body: `"${trigger}" starts ${old} today. Start ${target} instead? ${old} will no longer be started by it.`,
    title: "Move this wire?",
  };
}

/**
 * Only a configured trigger wire from a movable trigger can be deleted, since
 * that deletion revokes or removes the trigger. A historical wire has no row.
 */
export function isDeletableWire(
  graph: EditGraph,
  wire: { configured: boolean; from: string; kind: string }
): boolean {
  return (
    wire.configured &&
    wire.kind === "trigger" &&
    isMovableTriggerNode(nodeOf(graph, wire.from))
  );
}

/** The confirm text for deleting a trigger wire. */
export function disconnectMessage(
  graph: EditGraph,
  sourceKey: string
): { body: string; confirm: string; title: string } {
  const node = nodeOf(graph, sourceKey);
  if (node?.subkind === "http") {
    return {
      body: `Deleting this wire revokes "${node.label}" for good. Its address and secret stop working.`,
      confirm: "Revoke trigger",
      title: "Revoke this trigger?",
    };
  }
  if (node?.subkind === "routine") {
    return {
      body: `Deleting this wire removes the routine "${node.label}".`,
      confirm: "Remove schedule",
      title: "Remove this schedule?",
    };
  }
  return {
    body: "The connection between these two nodes is removed.",
    confirm: "Delete wire",
    title: "Delete this wire?",
  };
}

export type PendingPositions = Map<string, { x: number; y: number }>;

const SAVABLE_KEY =
  /^(?:agent:[^:\s]+|trigger:(?:slack:)?[^:\s]+|out:slack:[^:\s]+|out:library:\P{Cc}+|out:qa|out:email:[^:\s]+)$/u;
const MAX_SAVED_POSITIONS = 500;

/** The positions the server accepts, rounded to whole pixels, at most 500. */
export function positionsToSave(
  pending: PendingPositions
): { key: string; x: number; y: number }[] {
  const saved: { key: string; x: number; y: number }[] = [];
  for (const [key, position] of pending) {
    if (saved.length >= MAX_SAVED_POSITIONS) {
      break;
    }
    if (
      !(
        SAVABLE_KEY.test(key) &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y)
      )
    ) {
      continue;
    }
    saved.push({
      key,
      x: Math.round(position.x),
      y: Math.round(position.y),
    });
  }
  return saved;
}

/** The keys in `after` that were not in `before`, in their order in `after`. */
export function newNodeKeys(
  before: readonly string[],
  after: readonly string[]
): string[] {
  const known = new Set(before);
  return after.filter((key) => !known.has(key));
}

export interface PaletteItem {
  detail: string;
  key: string;
  label: string;
  setup: { href: string; label: string } | null;
  tool: MapTool;
}

export interface PaletteSection {
  empty: { href: string; label: string; text: string } | null;
  items: PaletteItem[];
  title: string;
}

function paletteItem(
  tool: MapTool,
  fields: Omit<PaletteItem, "key" | "tool">
): PaletteItem {
  return { ...fields, key: toolKey(tool), tool };
}

export function buildPalette(input: {
  connectors: { id: string; name: string; status: "ok" | "needs_auth" }[];
  machines: Pick<
    MachineRecord,
    "computerStatus" | "id" | "name" | "roles" | "status"
  >[];
  skills: { id: string; name: string; ownerAgentId: string | null }[];
}): PaletteSection[] {
  const connectors = input.connectors.map((connector) =>
    paletteItem(
      { id: connector.id, kind: "connector" },
      connector.status === "ok"
        ? { detail: "Ready", label: connector.name, setup: null }
        : {
            detail: "Needs setup",
            label: connector.name,
            setup: { href: "/settings/connectors", label: "Set up" },
          }
    )
  );

  const skills = input.skills
    .filter((skill) => skill.ownerAgentId === null)
    .map((skill) =>
      paletteItem(
        { id: skill.id, kind: "skill" },
        { detail: "", label: skill.name, setup: null }
      )
    );

  const computers = computersOf(input.machines).map((machine) =>
    paletteItem(
      { id: machine.id, kind: "computer" },
      {
        detail: machine.computerStatus === "online" ? "Online" : "Offline",
        label: machine.name,
        setup: null,
      }
    )
  );

  return [
    {
      empty:
        connectors.length > 0
          ? null
          : {
              href: "/settings/connectors",
              label: "Add a connector",
              text: "No connectors yet.",
            },
      items: connectors,
      title: "Connectors",
    },
    {
      empty:
        skills.length > 0
          ? null
          : { href: "/skills", label: "Open Skills", text: "No skills yet." },
      items: skills,
      title: "Skills",
    },
    {
      empty:
        computers.length > 0
          ? null
          : {
              href: "/settings/machines",
              label: "Add computer",
              text: "No computer is enrolled yet.",
            },
      items: computers,
      title: "Computers",
    },
    {
      empty: null,
      items: [
        paletteItem(
          { kind: "browser" },
          { detail: "Built in", label: "Browser", setup: null }
        ),
      ],
      title: "Browser",
    },
  ];
}
