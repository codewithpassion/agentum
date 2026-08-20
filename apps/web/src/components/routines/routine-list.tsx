import { Link } from "@tanstack/react-router";
import { useCallback } from "react";
import { Button } from "#/components/ui/button";
import type { Routine } from "#/lib/api";
import { describeSchedule } from "#/lib/schedule-format";
import { useWorkspaceSlug } from "#/lib/workspace-context";
import { NextRunLine, TargetLine } from "./routine-facts";
import { LastRunLine } from "./routine-status";

/**
 * The routines screen: everything that exists, when each next fires, and how
 * the last firing went - with the three things you actually do to a routine
 * (pause it, run it now, delete it) on the row itself.
 */

export interface RoutineActions {
  onDelete: (routine: Routine) => void;
  onNew: () => void;
  onRunNow: (routine: Routine) => void;
  onToggle: (routine: Routine) => void;
}

function RoutineRow({
  actions,
  busy,
  routine,
}: {
  actions: RoutineActions;
  busy: boolean;
  routine: Routine;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const { onDelete, onRunNow, onToggle } = actions;

  const toggle = useCallback(() => onToggle(routine), [onToggle, routine]);
  const runNow = useCallback(() => onRunNow(routine), [onRunNow, routine]);
  const remove = useCallback(() => onDelete(routine), [onDelete, routine]);

  return (
    <li className="rounded-lg border border-[var(--ws-line)] px-3 py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <Link
            className="ws-focus block truncate font-medium text-[13px] text-[var(--ws-text)] no-underline"
            params={{ routineId: routine.id, workspaceSlug }}
            to="/w/$workspaceSlug/routines/$routineId"
          >
            {routine.name}
          </Link>
          <TargetLine routine={routine} />
          <p className="m-0 text-[var(--ws-muted)] text-xs">
            {describeSchedule(routine.schedule, routine.timezone)}
          </p>
          <div className="flex flex-wrap items-center gap-x-3">
            <NextRunLine routine={routine} />
            <LastRunLine run={routine.lastRun} />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            disabled={busy}
            onClick={toggle}
            size="sm"
            title={
              routine.enabled
                ? "Stop firing on the schedule"
                : "Start firing again"
            }
          >
            {routine.enabled ? "Pause" : "Resume"}
          </Button>
          <Button disabled={busy} onClick={runNow} size="sm">
            Run now
          </Button>
          <Link
            className="ws-focus inline-flex h-7 shrink-0 items-center rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-2.5 font-medium text-[var(--ws-text)] text-xs no-underline hover:bg-[var(--ws-surface-hover)]"
            params={{ routineId: routine.id, workspaceSlug }}
            search={{ edit: true }}
            to="/w/$workspaceSlug/routines/$routineId"
          >
            Edit
          </Link>
          <Button disabled={busy} onClick={remove} size="sm" variant="danger">
            Delete
          </Button>
        </div>
      </div>
    </li>
  );
}

export function RoutineList({
  actions,
  busyId,
  routines,
}: {
  actions: RoutineActions;
  /** The routine a mutation is in flight for, if any. */
  busyId: string | null;
  routines: Routine[];
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="m-0 font-semibold text-lg">Routines</h2>
            <p className="m-0 text-[var(--ws-muted)] text-sm">
              A routine posts its instructions into a channel on a schedule and
              lets the agent get on with it, in the open.
            </p>
          </div>
          <Button
            data-testid="new-routine"
            onClick={actions.onNew}
            variant="primary"
          >
            New routine
          </Button>
        </header>

        {routines.length === 0 ? (
          <p className="m-0 text-[var(--ws-muted)] text-sm">
            No routines yet. Write the first one — "every weekday at 09:00,
            summarise yesterday" is a good place to start.
          </p>
        ) : (
          <ul
            className="m-0 list-none space-y-1.5 p-0"
            data-testid="routine-list"
          >
            {routines.map((routine) => (
              <RoutineRow
                actions={actions}
                busy={busyId === routine.id}
                key={routine.id}
                routine={routine}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
