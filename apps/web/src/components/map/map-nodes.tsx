import type { MapOutputKind, MapTriggerKind } from "@repo/db/shared";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import type {
  AgentFlowNode,
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
  waiting: "border-2 border-amber-500 bg-amber-50 dark:bg-amber-950",
};

const AGENT_BADGE: Partial<
  Record<TileStatus, { glyph: string; className: string }>
> = {
  ok: { className: "bg-emerald-600", glyph: "✓" },
  running: { className: "bg-emerald-600", glyph: "…" },
  waiting: { className: "bg-amber-500", glyph: "!" },
};

const MAX_PORT_CHIPS = 4;

const HANDLE_CLASS = "!size-1 !border-0 !bg-transparent";

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
        <div className="truncate text-[11.5px] text-muted-foreground leading-tight">
          {data.detail}
        </div>
      </div>
      <Handle
        className={HANDLE_CLASS}
        id="right"
        isConnectable={false}
        position={Position.Right}
        type="source"
      />
    </div>
  );
}

export function AgentNode({ id, data, selected }: NodeProps<AgentFlowNode>) {
  const badge = AGENT_BADGE[data.status];
  const shownPorts = data.ports.slice(0, MAX_PORT_CHIPS);
  const hiddenPorts = data.ports.length - shownPorts.length;

  return (
    <div
      className={cx(
        "relative flex h-full w-full items-center gap-2.5 rounded-xl px-3 shadow-sm",
        AGENT_SURFACE[data.status],
        selected && "ring-3 ring-ring/40"
      )}
      data-status={data.status}
      data-testid={`node-${id}`}
    >
      <Tile tone={data.tone}>{data.initials}</Tile>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold text-[13px] text-foreground leading-tight">
          {data.label}
        </div>
        <div className="truncate text-[11.5px] text-muted-foreground leading-tight">
          {data.statusText}
        </div>
        {data.ports.length > 0 && (
          <div className="mt-1 flex min-w-0 flex-wrap gap-1">
            {shownPorts.map((port) => (
              <span
                className="rounded border border-border px-1.5 text-[10.5px] text-muted-foreground leading-4"
                key={`${port.kind}-${port.label}`}
              >
                {port.label}
              </span>
            ))}
            {hiddenPorts > 0 && (
              <span className="rounded border border-border px-1.5 text-[10.5px] text-muted-foreground leading-4">
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
        className={HANDLE_CLASS}
        id="left"
        isConnectable={false}
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
        <div className="truncate text-[11.5px] text-muted-foreground leading-tight">
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
