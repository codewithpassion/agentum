import type { MapOutputKind, MapTriggerKind } from "@repo/db/shared";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { type DragEvent, type MouseEvent, useCallback, useState } from "react";
import {
  decodeTool,
  isMovableTrigger,
  TOOL_MIME,
  toolOfPort,
} from "./editor-logic.ts";
import { useMapEdit } from "./map-edit-context.ts";
import { agentIdOf, visiblePorts } from "./map-logic.ts";
import type {
  AgentFlowNode,
  MapPortData,
  OutputFlowNode,
  TileStatus,
  TileTone,
  TriggerFlowNode,
} from "./map-types.ts";

const cx = (...parts: (string | false | undefined)[]): string =>
  parts.filter(Boolean).join(" ");

const TILE_TONE: Record<TileTone, string> = {
  1: "bg-chart-1",
  2: "bg-chart-2",
  3: "bg-chart-3",
  4: "bg-chart-4",
};

const TRIGGER_GLYPH: Record<MapTriggerKind, string> = {
  app: "A",
  http: "↯",
  mail: "@",
  routine: "⏱",
  slack: "S",
};

const OUTPUT_GLYPH: Record<MapOutputKind, string> = {
  email: "@",
  library: "L",
  qa: "?",
  slack: "S",
};

const AGENT_SURFACE: Record<TileStatus, string> = {
  idle: "border-[1.5px] border-border bg-card",
  ok: "border-[1.5px] border-emerald-600 bg-card",
  running: "border-[1.5px] border-emerald-600 bg-card",
  waiting: "border-2 border-warning bg-warning/10",
};

const AGENT_BADGE: Partial<
  Record<TileStatus, { glyph: string; className: string }>
> = {
  ok: { className: "bg-emerald-600", glyph: "✓" },
  running: { className: "bg-emerald-600", glyph: "…" },
  waiting: { className: "bg-warning", glyph: "!" },
};

const MAX_PORT_CHIPS = 4;

const HANDLE_CLASS = "!size-1 !border-0 !bg-transparent";
/** The ends of a wire that Editor mode lets a person draw: big enough to grab. */
const EDIT_HANDLE_CLASS =
  "!size-3 !border-2 !border-emerald-600 !bg-card hover:!bg-emerald-600";

function Tile({ tone, children }: { tone: TileTone; children: string }) {
  return (
    <span
      className={cx(
        "grid size-[30px] flex-none place-items-center rounded-lg font-bold text-background text-xs",
        TILE_TONE[tone]
      )}
    >
      {children}
    </span>
  );
}

export function TriggerNode({ data }: NodeProps<TriggerFlowNode>) {
  const { editor } = useMapEdit();
  const wireable = editor && isMovableTrigger(data.subkind);
  return (
    <div
      className={cx(
        "relative flex h-full w-full items-center gap-2.5 rounded-r-xl rounded-l-[30px] border-[1.5px] bg-card px-3 shadow-sm",
        data.active ? "border-emerald-600" : "border-border"
      )}
    >
      <Tile tone={data.tone}>{TRIGGER_GLYPH[data.subkind]}</Tile>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold text-[13px] text-foreground leading-tight">
          {data.label}
        </div>
        <div className="truncate text-[11.5px] text-muted-foreground leading-tight max-md:text-[12px]">
          {data.detail}
        </div>
      </div>
      <Handle
        className={wireable ? EDIT_HANDLE_CLASS : HANDLE_CLASS}
        id="right"
        isConnectable={wireable}
        position={Position.Right}
        type="source"
      />
    </div>
  );
}

function PortChip({
  agentId,
  editor,
  port,
}: {
  agentId: string | null;
  editor: boolean;
  port: MapPortData;
}) {
  const { onUnplug } = useMapEdit();
  const remove = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      if (agentId !== null) {
        onUnplug(agentId, toolOfPort(port));
      }
    },
    [agentId, onUnplug, port]
  );
  return (
    <span className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 text-[10.5px] text-muted-foreground leading-4 max-md:text-[12px]">
      {port.label}
      {editor && agentId !== null ? (
        <button
          aria-label={`Remove ${port.label}`}
          className="nodrag nopan pointer-coarse:hidden cursor-pointer leading-none hover:text-destructive"
          onClick={remove}
          type="button"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

export function AgentNode({ id, data, selected }: NodeProps<AgentFlowNode>) {
  const { editor, onPlug } = useMapEdit();
  const agentId = agentIdOf(id);
  const [over, setOver] = useState(false);
  const acceptsDrop = useCallback(
    (event: DragEvent) =>
      editor && event.dataTransfer.types.includes(TOOL_MIME),
    [editor]
  );
  const handleDragOver = useCallback(
    (event: DragEvent) => {
      if (acceptsDrop(event)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      }
    },
    [acceptsDrop]
  );
  const handleDragLeave = useCallback(() => setOver(false), []);
  const handleDrop = useCallback(
    (event: DragEvent) => {
      setOver(false);
      if (!acceptsDrop(event) || agentId === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const tool = decodeTool(event.dataTransfer.getData(TOOL_MIME));
      if (tool !== null) {
        onPlug(agentId, tool);
      }
    },
    [acceptsDrop, agentId, onPlug]
  );
  const badge = AGENT_BADGE[data.status];
  const { hidden: hiddenPorts, shown: shownPorts } = visiblePorts(
    data.ports,
    MAX_PORT_CHIPS
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: a native drop target for tools dragged from the palette. The inspector's Tools row is the keyboard route.
    <div
      className={cx(
        "relative flex h-full w-full items-center gap-2.5 rounded-xl px-3 shadow-sm",
        AGENT_SURFACE[data.status],
        selected && "ring-3 ring-ring/40",
        over && "ring-4 ring-emerald-500/60"
      )}
      data-status={data.status}
      data-testid={`node-${id}`}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <Tile tone={data.tone}>{data.initials}</Tile>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold text-[13px] text-foreground leading-tight">
          {data.label}
        </div>
        <div className="truncate text-[11.5px] text-muted-foreground leading-tight max-md:text-[12px]">
          {data.statusText}
        </div>
        {data.ports.length > 0 && (
          <div className="mt-1 flex min-w-0 flex-wrap gap-1">
            {shownPorts.map((port) => (
              <PortChip
                agentId={agentId}
                editor={editor}
                key={`${port.kind}-${port.id}`}
                port={port}
              />
            ))}
            {hiddenPorts > 0 && (
              <span className="rounded border border-border px-1.5 text-[10.5px] text-muted-foreground leading-4 max-md:text-[12px]">
                +{hiddenPorts}
              </span>
            )}
          </div>
        )}
      </div>
      {badge !== undefined && (
        <span
          aria-hidden
          className={cx(
            "absolute -top-2 -right-2 grid size-5 place-items-center rounded-full font-bold text-[11px] text-white",
            badge.className
          )}
        >
          {badge.glyph}
        </span>
      )}
      <Handle
        className={editor ? EDIT_HANDLE_CLASS : HANDLE_CLASS}
        id="left"
        isConnectable={editor}
        position={Position.Left}
        type="target"
      />
      <Handle
        className={HANDLE_CLASS}
        id="right"
        isConnectable={false}
        position={Position.Right}
        type="source"
      />
      <Handle
        className={HANDLE_CLASS}
        id="top"
        isConnectable={false}
        position={Position.Top}
        type="target"
      />
      <Handle
        className={HANDLE_CLASS}
        id="bottom"
        isConnectable={false}
        position={Position.Bottom}
        type="source"
      />
      <Handle
        className={HANDLE_CLASS}
        id="top-out"
        isConnectable={false}
        position={Position.Top}
        type="source"
      />
      <Handle
        className={HANDLE_CLASS}
        id="bottom-in"
        isConnectable={false}
        position={Position.Bottom}
        type="target"
      />
    </div>
  );
}

export function OutputNode({ data }: NodeProps<OutputFlowNode>) {
  return (
    <div className="relative flex h-full w-full items-center gap-2.5 rounded-xl border-[1.5px] border-border bg-card px-3 shadow-sm">
      <Tile tone={data.tone}>{OUTPUT_GLYPH[data.subkind]}</Tile>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold text-[13px] text-foreground leading-tight">
          {data.label}
        </div>
        <div className="truncate text-[11.5px] text-muted-foreground leading-tight max-md:text-[12px]">
          {data.detail}
        </div>
      </div>
      <Handle
        className={HANDLE_CLASS}
        id="left"
        isConnectable={false}
        position={Position.Left}
        type="target"
      />
    </div>
  );
}

export const nodeTypes = {
  agent: AgentNode,
  output: OutputNode,
  trigger: TriggerNode,
};
