import { useCallback, useMemo, useState } from "react";
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
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { FitViewButton, MapCanvas } from "./map-canvas.tsx";
import { MapInspectorPane } from "./map-inspector-pane.tsx";
import { runCountsByAgent } from "./map-logic.ts";

const TASK_WINDOW = 100;

/** The graph, the runtimes for the tiles and the recent runs for the counts. */
const loadMap = async () => {
  const trpc = getTrpc();
  const [graph, agents, tasks] = await Promise.all([
    trpc.map.graph.query({ days: 7 }),
    trpc.agents.list.query({}),
    trpc.tasks.list.query({ limit: TASK_WINDOW }),
  ]);
  return {
    agents: new Map(
      agents.map((agent) => [agent.id, { runtime: agent.runtime }] as const)
    ),
    graph,
    tasks,
  };
};

/** Editor and Runs. Editor comes with a later task, so it stays off. */
function ModeToggle() {
  return (
    <fieldset
      aria-label="View"
      className="m-0 inline-flex overflow-hidden rounded-lg border border-border p-0"
    >
      <Button
        className="rounded-none"
        disabled
        size="sm"
        title="Editor mode comes later"
        type="button"
        variant="ghost"
      >
        Editor
      </Button>
      <Button
        aria-pressed
        className="rounded-none"
        size="sm"
        type="button"
        variant="secondary"
      >
        Runs · last 7 days
      </Button>
    </fieldset>
  );
}

export function MapPage() {
  const nowMs = useNowMs();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const { data, error, refresh } = usePolledQuery(
    loadMap,
    null,
    DESK_POLL_INTERVAL_MS
  );

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

  const closeInspector = useCallback(() => setSelectedKey(null), []);
  const selected =
    data?.graph.nodes.find((node) => node.key === selectedKey) ?? null;

  return (
    <section className="mx-auto flex max-w-7xl flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-60 flex-1">
          <h1 className="font-heading text-3xl text-foreground">Map</h1>
          <p className="text-muted-foreground text-sm">
            Who starts what, who hands to whom, and where the results go
          </p>
        </div>
        <ModeToggle />
        <FitViewButton />
      </header>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {data === null || nowMs === null ? (
        <p className="text-muted-foreground text-sm">Loading the map…</p>
      ) : (
        <div className="flex flex-wrap items-start gap-4">
          <div
            className="h-[min(70vh,640px)] min-w-0 flex-[999_1_600px] overflow-hidden rounded-xl border border-border"
            data-testid="map-board"
          >
            <MapCanvas
              agents={data.agents}
              graph={data.graph}
              onSelect={setSelectedKey}
              runCounts={runCounts}
              selectedKey={selectedKey}
            />
          </div>
          {selected === null ? null : (
            <div className="min-w-0 flex-[1_1_300px]">
              <MapInspectorPane
                graph={data.graph}
                key={selected.key}
                node={selected}
                nowMs={nowMs}
                onAnswer={answer}
                onClose={closeInspector}
              />
            </div>
          )}
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        Green wires carried work in the last 7 days, grey ones are idle. Counts
        are items passed along each wire.
      </p>
    </section>
  );
}
