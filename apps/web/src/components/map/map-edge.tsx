import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from "@xyflow/react";
import { type MapFlowEdge, WIRE_COLOR } from "./map-types.ts";

export function CountEdge({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  data,
  label,
  markerEnd,
  id,
}: EdgeProps<MapFlowEdge>) {
  const carried = data?.carried === true;
  const active = data?.active === true;
  const [path, labelX, labelY] = getBezierPath({
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY,
  });

  return (
    <>
      <BaseEdge
        className={active ? "animate-pulse" : undefined}
        id={id}
        markerEnd={markerEnd}
        path={path}
        style={{
          stroke: carried ? WIRE_COLOR.carried : WIRE_COLOR.idle,
          strokeWidth: 2,
          ...(active ? { strokeDasharray: "6 4" } : {}),
        }}
      />
      {label !== undefined && label !== null && (
        <EdgeLabelRenderer>
          <div
            className={`nodrag nopan pointer-events-none absolute rounded-full border bg-card px-1.5 font-semibold text-[11px] leading-[18px] ${
              carried
                ? "border-emerald-600 text-emerald-700 dark:text-emerald-300"
                : "border-border text-foreground"
            }`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = {
  count: CountEdge,
};
