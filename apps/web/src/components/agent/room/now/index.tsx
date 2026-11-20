import { type ReactNode, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  pendingTakeover,
  type TakeoverRequest,
} from "#/components/task/task-logic.ts";
import { initialLive, requestViews } from "#/components/task/task-state.ts";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import type { RoomTabProps } from "../room-data.ts";
import { HelpersCard } from "./helpers-card.tsx";
import { LearnedSlot } from "./learned-slot.tsx";
import { MadeToday } from "./made-today.tsx";
import {
  activeRun,
  type Helper,
  latestStep,
  liveHelpers,
  type StepLine,
  type TaskListItem,
} from "./now-logic.ts";
import { ScreenCard } from "./screen-card.tsx";
import { StepCard } from "./step-card.tsx";
import { type MadeTodayData, useLiveWork, useMadeToday } from "./use-now.ts";

/** Everything the panel draws, already read. The cards render nothing for what the agent does not have. */
export interface NowPanelViewProps {
  agentName: string;
  /** The helpers being stopped. */
  busyHelperIds: readonly string[];
  /** Why the last read failed, or null. The panel keeps showing the last good read. */
  error: string | null;
  helpers: readonly Helper[];
  /** Learned this week, filled by the Knows tab's list. */
  learned: ReactNode;
  machineId: string | null;
  madeToday: MadeTodayData;
  onStopHelper: (runId: string) => void;
  run: Pick<TaskListItem, "id" | "title"> | null;
  step: StepLine | null;
  takeover: TakeoverRequest | null;
}

/** The right side of the agent room: live work, the screen, helpers, what it made today and what it learned. */
export function NowPanelView({
  agentName,
  busyHelperIds,
  error,
  helpers,
  learned,
  machineId,
  madeToday,
  onStopHelper,
  run,
  step,
  takeover,
}: NowPanelViewProps) {
  return (
    <aside
      aria-label={`${agentName} right now`}
      className="flex min-w-0 flex-col gap-3"
      data-testid="now-panel"
    >
      {error === null ? null : (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
      <StepCard run={run} step={step} />
      <ScreenCard
        agentName={agentName}
        machineId={machineId}
        takeover={takeover}
      />
      <HelpersCard
        busyIds={busyHelperIds}
        helpers={helpers}
        onStop={onStopHelper}
      />
      <MadeToday artifacts={madeToday.artifacts} files={madeToday.files} />
      {learned}
    </aside>
  );
}

function LivePanel({
  agent,
  initialTasks,
  nowMs,
}: {
  agent: RoomTabProps["room"]["agent"];
  initialTasks: RoomTabProps["room"]["tasks"];
  nowMs: number | null;
}) {
  const { error, refresh, task, tasks } = useLiveWork({
    agentId: agent.id,
    initialTasks,
  });
  const run = activeRun(tasks);
  const madeToday = useMadeToday({ nowMs, running: run !== null, tasks });
  const [busyHelperIds, setBusyHelperIds] = useState<string[]>([]);

  const stopHelper = useCallback(
    async (runId: string) => {
      setBusyHelperIds((ids) => [...ids, runId]);
      try {
        await getTrpc().runs.cancel.mutate({ runId });
      } catch (cause) {
        toast.error(errorMessage(cause, "Could not stop the helper."));
      }
      await refresh();
      setBusyHelperIds((ids) => ids.filter((id) => id !== runId));
    },
    [refresh]
  );

  const takeover = useMemo(
    () =>
      task === null ? null : pendingTakeover(requestViews(initialLive(task))),
    [task]
  );
  return (
    <NowPanelView
      agentName={agent.name}
      busyHelperIds={busyHelperIds}
      error={error}
      helpers={task === null ? [] : liveHelpers(task)}
      learned={<LearnedSlot agent={agent} />}
      machineId={agent.computerMachineId}
      madeToday={madeToday}
      onStopHelper={stopHelper}
      run={run}
      step={task === null ? null : latestStep(task)}
      takeover={takeover}
    />
  );
}

/**
 * The Right now panel of the Chat and Work tabs. It reads the agent's tasks
 * again every few seconds, so the step line follows the running task. An
 * archived agent has no live work, so it shows nothing.
 */
export function NowPanel({
  nowMs,
  room,
}: Pick<RoomTabProps, "nowMs" | "room">) {
  const { agent, tasks } = room;
  if (agent.status === "archived") {
    return null;
  }
  return (
    <LivePanel
      agent={agent}
      initialTasks={tasks}
      key={agent.id}
      nowMs={nowMs}
    />
  );
}
