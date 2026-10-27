import { Link, useNavigate } from "@tanstack/react-router";
import {
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DESK_POLL_INTERVAL_MS,
  usePolledQuery,
} from "#/components/inbox/use-polled-query.ts";
import {
  type AnswerPayload,
  isConflict,
  type RequestView,
} from "#/components/requests/request-card-logic.ts";
import { useNowMs } from "#/components/task/use-now-ms.ts";
import { errorMessage } from "#/components/triggers/format.ts";
import { Button, buttonVariants } from "#/components/ui/button.tsx";
import { useIsMobile } from "#/hooks/use-mobile.ts";
import { getTrpc } from "#/integrations/trpc/client";
import {
  disconnectMessage,
  encodeNewNode,
  isDeletableWire,
  type MapTool,
  moveWireMessage,
  NEW_NODE_MIME,
  type NewNodeKind,
  newNodeKeys,
  triggerIdOfKey,
} from "./editor-logic.ts";
import { FitViewButton, MapCanvas, type MapPosition } from "./map-canvas.tsx";
import {
  type ConfirmRequest,
  MapConfirmDialog,
} from "./map-confirm-dialog.tsx";
import { MapEditContext } from "./map-edit-context.ts";
import { MapInspectorPane } from "./map-inspector-pane.tsx";
import { agentIdOf, runCountsByAgent } from "./map-logic.ts";
import { PickBanner, SideArea } from "./map-touch-panels.tsx";
import { NewTriggerFlow } from "./new-trigger-flow.tsx";
import {
  forgetAgentDrop,
  recallAgentDrop,
  rememberAgentDrop,
  resolveAgentDrop,
} from "./pending-drop.ts";
import { useTapToPlug } from "./use-tap-to-plug.ts";

const TASK_WINDOW = 100;

/** The graph, the runtimes for the tiles and the recent runs for the counts. */
const loadMap = async () => {
  const trpc = getTrpc();
  const [graph, agents, tasks, qaOpenCount] = await Promise.all([
    trpc.map.graph.query({ days: 7 }),
    trpc.agents.list.query({}),
    trpc.tasks.list.query({ limit: TASK_WINDOW }),
    trpc.qa.openCount.query(),
  ]);
  return {
    agents: new Map(
      agents.map((agent) => [agent.id, { runtime: agent.runtime }] as const)
    ),
    graph,
    qaOpenCount,
    tasks,
  };
};

type Mode = "editor" | "runs";

/** Editor and Runs. */
function ModeToggle({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
}) {
  const showEditor = useCallback(() => onChange("editor"), [onChange]);
  const showRuns = useCallback(() => onChange("runs"), [onChange]);
  return (
    <fieldset
      aria-label="View"
      className="m-0 inline-flex overflow-hidden rounded-lg border border-border p-0"
    >
      <Button
        aria-pressed={mode === "editor"}
        className="rounded-none"
        onClick={showEditor}
        size="sm"
        type="button"
        variant={mode === "editor" ? "secondary" : "ghost"}
      >
        Editor
      </Button>
      <Button
        aria-pressed={mode === "runs"}
        className="rounded-none"
        onClick={showRuns}
        size="sm"
        type="button"
        variant={mode === "runs" ? "secondary" : "ghost"}
      >
        Runs · last 7 days
      </Button>
    </fieldset>
  );
}

/** "+ Trigger" and "+ Agent": click to make one, or drag one onto the canvas to make it there. */
function NewNodeButtons({ onNewTrigger }: { onNewTrigger: () => void }) {
  const dragTrigger = useCallback((event: DragEvent) => {
    event.dataTransfer.setData(NEW_NODE_MIME, encodeNewNode("trigger"));
    event.dataTransfer.effectAllowed = "copy";
  }, []);
  const dragAgent = useCallback((event: DragEvent) => {
    event.dataTransfer.setData(NEW_NODE_MIME, encodeNewNode("agent"));
    event.dataTransfer.effectAllowed = "copy";
  }, []);
  return (
    <>
      <Button
        draggable
        onClick={onNewTrigger}
        onDragStart={dragTrigger}
        size="sm"
        type="button"
        variant="outline"
      >
        + Trigger
      </Button>
      <Link
        className={buttonVariants({ size: "sm", variant: "outline" })}
        draggable
        onDragStart={dragAgent}
        to="/agents/new"
      >
        + Agent
      </Link>
    </>
  );
}

/** The agents a new trigger can start, from the map's own agent nodes. */
const agentOptions = (graph: {
  nodes: { key: string; kind: string; label: string }[];
}): { id: string; name: string }[] =>
  graph.nodes.flatMap((node) => {
    const id = agentIdOf(node.key);
    return node.kind === "agent" && id !== null
      ? [{ id, name: node.label }]
      : [];
  });

const NEW_AGENT_PATH = "/agents/new";

export function MapPage() {
  const nowMs = useNowMs();
  const isMobile = useIsMobile();
  const boardRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("runs");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // `known` is the node keys when the flow opened, so a poll cannot hide the new node.
  const [newTrigger, setNewTrigger] = useState<{
    known: string[];
    position: MapPosition | null;
  } | null>(null);
  const { data, error, refresh } = usePolledQuery(
    loadMap,
    null,
    DESK_POLL_INTERVAL_MS
  );
  const editor = mode === "editor";
  const graph = data?.graph ?? null;

  const runCounts = useMemo(
    () =>
      data === null || nowMs === null
        ? new Map<string, number>()
        : runCountsByAgent(data.tasks, nowMs),
    [data, nowMs]
  );

  const answer = useCallback(
    async (view: RequestView, payload: AnswerPayload) => {
      try {
        await getTrpc().requests.answer.mutate({
          ...payload,
          requestId: view.id,
        });
      } catch (cause) {
        if (!isConflict(cause)) {
          throw cause;
        }
      }
      await refresh();
    },
    [refresh]
  );

  /** Runs an edit, shows its failure in the banner and reloads the graph. */
  const edit = useCallback(
    async (change: () => Promise<unknown>) => {
      setEditError(null);
      try {
        await change();
      } catch (cause) {
        setEditError(errorMessage(cause));
      }
      await refresh();
    },
    [refresh]
  );

  const savePositions = useCallback(
    (positions: { key: string; x: number; y: number }[]) =>
      edit(() => getTrpc().map.savePositions.mutate(positions)),
    [edit]
  );

  const plug = useCallback(
    (agentId: string, tool: MapTool) =>
      edit(() => getTrpc().map.plugTool.mutate({ agentId, tool })),
    [edit]
  );
  const unplug = useCallback(
    (agentId: string, tool: MapTool) =>
      edit(() => getTrpc().map.unplugTool.mutate({ agentId, tool })),
    [edit]
  );

  const askConfirm = useCallback((request: ConfirmRequest) => {
    setConfirmError(null);
    setConfirm(request);
  }, []);

  const connectWire = useCallback(
    (sourceKey: string, targetKey: string) => {
      const triggerId = triggerIdOfKey(sourceKey);
      const agentId = agentIdOf(targetKey);
      if (graph === null || triggerId === null || agentId === null) {
        return;
      }
      const message = moveWireMessage(graph, sourceKey, targetKey);
      askConfirm({
        body: message.body,
        confirm: "Connect",
        destructive: false,
        run: async () => {
          await getTrpc().map.connectTrigger.mutate({ agentId, triggerId });
        },
        title: message.title,
      });
    },
    [askConfirm, graph]
  );

  const deleteWire = useCallback(
    (edgeId: string) => {
      const wire = graph?.wires.find(
        (candidate) =>
          `${candidate.kind}:${candidate.from}:${candidate.to}` === edgeId
      );
      const triggerId = wire === undefined ? null : triggerIdOfKey(wire.from);
      if (
        graph === null ||
        wire === undefined ||
        triggerId === null ||
        !isDeletableWire(graph, wire)
      ) {
        return;
      }
      const message = disconnectMessage(graph, wire.from);
      askConfirm({
        body: message.body,
        confirm: message.confirm,
        destructive: true,
        run: async () => {
          await getTrpc().map.disconnectTrigger.mutate({ triggerId });
        },
        title: message.title,
      });
    },
    [askConfirm, graph]
  );

  const cancelConfirm = useCallback(() => setConfirm(null), []);
  const runConfirm = useCallback(async () => {
    if (confirm === null) {
      return;
    }
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirm.run();
      setConfirm(null);
      await refresh();
    } catch (cause) {
      setConfirmError(errorMessage(cause));
    } finally {
      setConfirming(false);
    }
  }, [confirm, refresh]);

  const nodeKeys = useMemo(
    () => graph?.nodes.map((node) => node.key) ?? [],
    [graph]
  );

  const dropNew = useCallback(
    (kind: NewNodeKind, position: MapPosition) => {
      if (kind === "trigger") {
        setNewTrigger({ known: nodeKeys, position });
        return;
      }
      rememberAgentDrop({
        at: Date.now(),
        known: nodeKeys.filter((key) => agentIdOf(key) !== null),
        x: position.x,
        y: position.y,
      });
      navigate({ to: NEW_AGENT_PATH });
    },
    [navigate, nodeKeys]
  );
  const openNewTrigger = useCallback(
    () => setNewTrigger({ known: nodeKeys, position: null }),
    [nodeKeys]
  );

  /** A trigger was made: put its node where it was dropped, when it was dropped. */
  const finishNewTrigger = useCallback(
    async (created: boolean) => {
      const position = newTrigger?.position ?? null;
      const before = newTrigger?.known ?? [];
      setNewTrigger(null);
      if (!created) {
        return;
      }
      if (position !== null) {
        await edit(async () => {
          const next = await getTrpc().map.graph.query({ days: 7 });
          const [key] = newNodeKeys(
            before,
            next.nodes.map((node) => node.key)
          );
          if (key !== undefined) {
            await getTrpc().map.savePositions.mutate([
              { key, x: Math.round(position.x), y: Math.round(position.y) },
            ]);
          }
        });
        return;
      }
      await refresh();
    },
    [edit, newTrigger, refresh]
  );

  // An agent made in the builder lands where "+ Agent" was dropped.
  useEffect(() => {
    const drop = recallAgentDrop();
    if (drop === null || graph === null) {
      return;
    }
    const outcome = resolveAgentDrop(
      drop,
      graph.nodes.map((node) => node.key),
      Date.now()
    );
    if (outcome.kind === "wait") {
      return;
    }
    forgetAgentDrop();
    if (outcome.kind === "place") {
      savePositions([
        {
          key: outcome.key,
          x: Math.round(outcome.x),
          y: Math.round(outcome.y),
        },
      ]);
    }
  }, [graph, savePositions]);

  const editApi = useMemo(
    () => ({
      editor,
      onDeleteWire: deleteWire,
      onPlug: plug,
      onUnplug: unplug,
    }),
    [editor, deleteWire, plug, unplug]
  );

  const { cancelPick, clearPick, pickTool, picked, selectNode } = useTapToPlug({
    boardRef,
    plug,
    select: setSelectedKey,
  });
  const touch = useMemo(
    () => ({
      onConnectWire: connectWire,
      onDeleteWire: deleteWire,
      onUnplug: unplug,
    }),
    [connectWire, deleteWire, unplug]
  );

  const changeMode = useCallback(
    (next: Mode) => {
      setMode(next);
      clearPick();
      setEditError(null);
    },
    [clearPick]
  );
  const closeInspector = useCallback(() => setSelectedKey(null), []);
  const reload = useCallback(() => {
    refresh();
  }, [refresh]);
  const selected =
    data?.graph.nodes.find((node) => node.key === selectedKey) ?? null;

  const inspector =
    data === null || nowMs === null || selected === null ? null : (
      <MapInspectorPane
        editor={editor}
        graph={data.graph}
        key={`${selected.key}:${editor}`}
        node={selected}
        nowMs={nowMs}
        onAnswer={answer}
        onChanged={reload}
        onClose={closeInspector}
        touch={touch}
      />
    );
  return (
    <section className="mx-auto flex max-w-7xl flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-60 flex-1">
          <h1 className="font-heading text-3xl text-foreground">Map</h1>
          <p className="text-muted-foreground text-sm">
            Who starts what, who hands to whom, and where the results go
          </p>
        </div>
        <ModeToggle mode={mode} onChange={changeMode} />
        {editor ? <NewNodeButtons onNewTrigger={openNewTrigger} /> : null}
        <FitViewButton />
      </header>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {editError === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {editError}
        </p>
      )}
      {data === null || nowMs === null ? (
        <p className="text-muted-foreground text-sm">Loading the map…</p>
      ) : (
        <div className="flex flex-wrap items-start gap-4">
          <div
            className="flex min-w-0 flex-[999_1_600px] scroll-mt-20 flex-col gap-2"
            ref={boardRef}
          >
            {picked === null ? null : (
              <PickBanner item={picked} onCancel={cancelPick} />
            )}
            <div
              className="h-[min(70vh,640px)] overflow-hidden rounded-xl border border-border"
              data-testid="map-board"
            >
              <MapEditContext.Provider value={editApi}>
                <MapCanvas
                  agents={data.agents}
                  editor={editor}
                  graph={data.graph}
                  onConnectWire={connectWire}
                  onDropNew={dropNew}
                  onSavePositions={savePositions}
                  onSelect={selectNode}
                  qaOpenCount={data.qaOpenCount}
                  runCounts={runCounts}
                  selectedKey={selectedKey}
                />
              </MapEditContext.Provider>
            </div>
          </div>
          <SideArea
            editor={editor}
            inspector={inspector}
            isMobile={isMobile}
            label={selected?.label ?? "Selected node"}
            onClose={closeInspector}
            onPick={pickTool}
            pickedKey={picked?.key ?? null}
          />
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        Green wires carried work in the last 7 days, grey ones are idle. Counts
        are items passed along each wire.
        {editor
          ? " Drag nodes to move them, draw a wire from a trigger to an agent, and drop a tool on an agent to plug it in. On a phone, tap a tool, then an agent, and use the node's panel to connect or unplug."
          : ""}
      </p>
      {confirm === null ? null : (
        <MapConfirmDialog
          error={confirmError}
          onCancel={cancelConfirm}
          onConfirm={runConfirm}
          pending={confirming}
          request={confirm}
        />
      )}
      {newTrigger === null || data === null ? null : (
        <NewTriggerFlow
          agents={agentOptions(data.graph)}
          onDone={finishNewTrigger}
        />
      )}
    </section>
  );
}
