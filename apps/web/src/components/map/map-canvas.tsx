import {
  Background,
  BackgroundVariant,
  ReactFlow,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./map-flow.css";
import type { AgentRuntime } from "@repo/db/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { edgeTypes } from "./map-edge.tsx";
import { toFlowEdges, toFlowNodes } from "./map-logic.ts";
import { nodeTypes } from "./map-nodes.tsx";
import type { MapFlowNode } from "./map-types.ts";

type MapGraphView = RouterOutputs["map"]["graph"];

const FIT_OPTIONS = { duration: 200, padding: 0.15 } as const;

type Theme = "dark" | "light";

const themeOfPage = (): Theme =>
  document.documentElement.classList.contains("dark") ? "dark" : "light";

/**
 * The theme class on <html>. xyflow puts its own `light` class on the canvas
 * unless told the mode, and the app's tokens read that class, so a dark page
 * would get light tokens inside the map.
 */
function usePageTheme(): Theme {
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    setTheme(themeOfPage());
    const observer = new MutationObserver(() => setTheme(themeOfPage()));
    observer.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** The map as a read-only xyflow canvas, with the Runs toolbar above it. */
export function MapCanvas({
  agents,
  graph,
  onSelect,
  runCounts,
  selectedKey,
}: {
  agents: Map<string, { runtime: AgentRuntime }>;
  graph: MapGraphView;
  onSelect: (key: string | null) => void;
  runCounts: Map<string, number>;
  selectedKey: string | null;
}) {
  const nodes = useMemo(
    () => toFlowNodes(graph, { agents, runCounts, selectedKey }),
    [graph, agents, runCounts, selectedKey]
  );
  const edges = useMemo(() => toFlowEdges(graph), [graph]);
  const theme = usePageTheme();

  const handleNodeClick = useCallback(
    (_event: unknown, node: MapFlowNode) => onSelect(node.id),
    [onSelect]
  );
  const handlePaneClick = useCallback(() => onSelect(null), [onSelect]);

  return (
    <ReactFlow
      className="map-flow"
      colorMode={theme}
      edges={edges}
      edgeTypes={edgeTypes}
      elementsSelectable
      fitView
      fitViewOptions={FIT_OPTIONS}
      maxZoom={1.5}
      minZoom={0.3}
      nodes={nodes}
      nodesConnectable={false}
      nodesDraggable={false}
      nodesFocusable
      nodeTypes={nodeTypes}
      onNodeClick={handleNodeClick}
      onPaneClick={handlePaneClick}
    >
      <Background gap={18} size={1.2} variant={BackgroundVariant.Dots} />
    </ReactFlow>
  );
}

/** Fits the whole map into view. It needs the flow provider above it. */
export function FitViewButton() {
  const { fitView } = useReactFlow();
  const handleClick = useCallback(() => {
    fitView(FIT_OPTIONS);
  }, [fitView]);
  return (
    <Button onClick={handleClick} size="sm" type="button" variant="outline">
      Fit view
    </Button>
  );
}
