import {
  Background,
  BackgroundVariant,
  type Connection,
  type NodeChange,
  ReactFlow,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./map-flow.css";
import type { AgentRuntime } from "@repo/db/shared";
import {
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";
import type { RouterOutputs } from "#/integrations/trpc/types";
import {
  decodeNewNode,
  isValidTriggerConnection,
  NEW_NODE_MIME,
  type NewNodeKind,
  type PendingPositions,
  positionsToSave,
} from "./editor-logic.ts";
import { edgeTypes } from "./map-edge.tsx";
import { toFlowEdges, toFlowNodes } from "./map-logic.ts";
import { nodeTypes } from "./map-nodes.tsx";
import type { MapFlowNode } from "./map-types.ts";

type MapGraphView = RouterOutputs["map"]["graph"];

const FIT_OPTIONS = { duration: 200, padding: 0.15 } as const;

/** How long a drag settles before its positions are saved. */
const SAVE_DEBOUNCE_MS = 500;
const DELETE_KEYS = ["Backspace", "Delete"];

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

export interface MapPosition {
  x: number;
  y: number;
}

/**
 * Where nodes sit while a person drags them. A drag moves a local copy at once
 * and the save follows after a pause, so the graph poll cannot snap a node
 * back in between. The copy is dropped once its save is in.
 */
function usePositionOverrides(
  save: (positions: { key: string; x: number; y: number }[]) => Promise<void>
) {
  const [overrides, setOverrides] = useState<PendingPositions>(new Map());
  const pending = useRef<PendingPositions>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  const flush = useCallback(async () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const batch = new Map(pending.current);
    pending.current.clear();
    const positions = positionsToSave(batch);
    if (positions.length === 0) {
      return;
    }
    try {
      await saveRef.current(positions);
    } finally {
      setOverrides((previous) => {
        const next = new Map(previous);
        for (const key of batch.keys()) {
          // A node dragged again since stays where it is.
          if (!pending.current.has(key)) {
            next.delete(key);
          }
        }
        return next;
      });
    }
  }, []);

  useEffect(
    () => () => {
      flush();
    },
    [flush]
  );

  const move = useCallback((changes: NodeChange<MapFlowNode>[]) => {
    const moves = changes.flatMap((change) =>
      change.type === "position" && change.position !== undefined
        ? [{ id: change.id, position: change.position }]
        : []
    );
    if (moves.length === 0) {
      return;
    }
    setOverrides((previous) => {
      const next = new Map(previous);
      for (const entry of moves) {
        next.set(entry.id, entry.position);
      }
      return next;
    });
  }, []);

  const drop = useCallback(
    (nodes: { id: string; position: MapPosition }[]) => {
      for (const node of nodes) {
        pending.current.set(node.id, node.position);
      }
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => {
        flush();
      }, SAVE_DEBOUNCE_MS);
    },
    [flush]
  );

  return { drop, move, overrides };
}

/**
 * The map as an xyflow canvas. In Editor mode nodes drag, a trigger's wire is
 * drawn to an agent, and "+ Trigger" and "+ Agent" can be dropped on it.
 */
export function MapCanvas({
  agents,
  editor,
  graph,
  onConnectWire,
  onDeleteWire,
  onDropNew,
  onSavePositions,
  onSelect,
  qaOpenCount,
  runCounts,
  selectedKey,
}: {
  agents: Map<string, { runtime: AgentRuntime }>;
  editor: boolean;
  graph: MapGraphView;
  /** A wire was drawn from a trigger node to an agent node. */
  onConnectWire: (sourceKey: string, targetKey: string) => void;
  /** Delete was pressed on a selected wire. `edgeId` is the xyflow edge id. */
  onDeleteWire: (edgeId: string) => void;
  /** A "+ Trigger" or "+ Agent" button was dropped on the canvas. */
  onDropNew: (kind: NewNodeKind, position: MapPosition) => void;
  onSavePositions: (
    positions: { key: string; x: number; y: number }[]
  ) => Promise<void>;
  onSelect: (key: string | null) => void;
  qaOpenCount: number;
  runCounts: Map<string, number>;
  selectedKey: string | null;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const { drop, move, overrides } = usePositionOverrides(onSavePositions);
  const nodes = useMemo(
    () =>
      toFlowNodes(graph, {
        agents,
        editor,
        qaOpenCount,
        runCounts,
        selectedKey,
      }).map((node) => {
        const position = overrides.get(node.id);
        return position === undefined ? node : { ...node, position };
      }),
    [graph, agents, editor, qaOpenCount, runCounts, selectedKey, overrides]
  );
  const edges = useMemo(() => toFlowEdges(graph, editor), [graph, editor]);
  const theme = usePageTheme();

  const handleNodeClick = useCallback(
    (_event: unknown, node: MapFlowNode) => onSelect(node.id),
    [onSelect]
  );
  const handlePaneClick = useCallback(() => onSelect(null), [onSelect]);
  const handleNodeDragStop = useCallback(
    (
      _event: unknown,
      _node: MapFlowNode,
      dragged: { id: string; position: MapPosition }[]
    ) => drop(dragged),
    [drop]
  );
  const handleConnect = useCallback(
    (connection: Connection) =>
      onConnectWire(connection.source, connection.target),
    [onConnectWire]
  );
  const isValidConnection = useCallback(
    (connection: { source: string; target: string }) =>
      isValidTriggerConnection(graph, connection.source, connection.target),
    [graph]
  );
  // A wire is deleted through the confirm, never straight from the key press.
  const handleBeforeDelete = useCallback(
    ({ edges: doomed }: { edges: { id: string }[] }) => {
      for (const edge of doomed) {
        onDeleteWire(edge.id);
      }
      return Promise.resolve(false);
    },
    [onDeleteWire]
  );
  const handleDragOver = useCallback(
    (event: DragEvent) => {
      if (editor && event.dataTransfer.types.includes(NEW_NODE_MIME)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    },
    [editor]
  );
  const handleDrop = useCallback(
    (event: DragEvent) => {
      const kind = decodeNewNode(event.dataTransfer.getData(NEW_NODE_MIME));
      if (!editor || kind === null) {
        return;
      }
      event.preventDefault();
      onDropNew(
        kind,
        screenToFlowPosition({ x: event.clientX, y: event.clientY })
      );
    },
    [editor, onDropNew, screenToFlowPosition]
  );

  return (
    <ReactFlow
      className="map-flow"
      colorMode={theme}
      deleteKeyCode={editor ? DELETE_KEYS : null}
      edges={edges}
      edgeTypes={edgeTypes}
      elementsSelectable
      fitView
      fitViewOptions={FIT_OPTIONS}
      isValidConnection={isValidConnection}
      maxZoom={1.5}
      minZoom={0.3}
      nodes={nodes}
      nodesConnectable={editor}
      nodesDraggable={editor}
      nodesFocusable
      nodeTypes={nodeTypes}
      onBeforeDelete={handleBeforeDelete}
      onConnect={handleConnect}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onNodeClick={handleNodeClick}
      onNodeDragStop={handleNodeDragStop}
      onNodesChange={move}
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
