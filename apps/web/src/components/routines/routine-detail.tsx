import { Link } from "@tanstack/react-router";
import { useCallback } from "react";
import { Button } from "#/components/ui/button";
import type { Routine, RoutineRun } from "#/lib/api";
import { formatRelativeTime } from "#/lib/format";
import { describeSchedule, formatInZone } from "#/lib/schedule-format";
import { useWorkspaceSlug } from "#/lib/workspace-context";
import { NextRunLine, TargetLine } from "./routine-facts";
import { RUN_STATUS_LABELS, RunStatusDot } from "./routine-status";

/**
 * One routine and what it has actually done. Every posted run links into the
 * channel at the message it wrote, which is the whole point of firing in the
 * open: the history is the conversation, not a log of it.
 */

function RunRow({ routine, run }: { routine: Routine; run: RoutineRun }) {
  const workspaceSlug = useWorkspaceSlug();

  return (
    <li className="flex items-start gap-3 rounded-lg border border-[var(--ws-line)] px-3 py-2">
      <span className="mt-1.5">
        <RunStatusDot run={run} />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="m-0 text-[13px] text-[var(--ws-text)]">
          {RUN_STATUS_LABELS[run.status]} {formatRelativeTime(run.firedAt)}
        </p>
        <p className="m-0 text-[var(--ws-muted)] text-xs">
          Fired {formatInZone(run.firedAt, routine.timezone)}, for the{" "}
          {formatInZone(run.scheduledFor, routine.timezone)} slot
        </p>
        {run.error ? (
          <p className="m-0 text-[var(--ws-danger)] text-xs">{run.error}</p>
        ) : null}
      </div>
      {run.messageId ? (
        <Link
          className="ws-focus shrink-0 text-[var(--ws-accent)] text-xs no-underline"
          params={{ workspaceSlug }}
          search={{ channel: run.channelId, message: run.messageId }}
          to="/w/$workspaceSlug"
        >
          View thread
        </Link>
      ) : null}
    </li>
  );
}

export function RoutineDetail({
  busy,
  loadMore,
  onDelete,
  onEdit,
  onRunNow,
  onToggle,
  routine,
  runs,
}: {
  busy: boolean;
  /** Null when there is nothing older left to fetch. */
  loadMore: (() => Promise<void>) | null;
  onDelete: (routine: Routine) => void;
  onEdit: () => void;
  onRunNow: (routine: Routine) => void;
  onToggle: (routine: Routine) => void;
  routine: Routine;
  runs: RoutineRun[];
}) {
  const toggle = useCallback(() => onToggle(routine), [onToggle, routine]);
  const runNow = useCallback(() => onRunNow(routine), [onRunNow, routine]);
  const remove = useCallback(() => onDelete(routine), [onDelete, routine]);
  const older = useCallback(() => {
    loadMore?.();
  }, [loadMore]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <header className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <h2 className="m-0 truncate font-semibold text-lg">
                {routine.name}
              </h2>
              <TargetLine routine={routine} />
              <p className="m-0 text-[var(--ws-muted)] text-xs">
                {describeSchedule(routine.schedule, routine.timezone)}
              </p>
              <NextRunLine routine={routine} />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button disabled={busy} onClick={toggle} size="sm">
                {routine.enabled ? "Pause" : "Resume"}
              </Button>
              <Button disabled={busy} onClick={runNow} size="sm">
                Run now
              </Button>
              <Button onClick={onEdit} size="sm">
                Edit
              </Button>
              <Button
                disabled={busy}
                onClick={remove}
                size="sm"
                variant="danger"
              >
                Delete
              </Button>
            </div>
          </div>
          <p className="m-0 whitespace-pre-wrap rounded-lg bg-[var(--ws-surface)] px-3 py-2 text-[13px] text-[var(--ws-text)]">
            {routine.instructions}
          </p>
        </header>

        <section className="space-y-2">
          <h3 className="m-0 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
            Run history
          </h3>
          {runs.length === 0 ? (
            <p className="m-0 text-[var(--ws-muted)] text-sm">
              This routine has not run yet.
            </p>
          ) : (
            <ul
              className="m-0 list-none space-y-1.5 p-0"
              data-testid="routine-runs"
            >
              {runs.map((run) => (
                <RunRow key={run.id} routine={routine} run={run} />
              ))}
            </ul>
          )}
          {loadMore ? (
            <Button onClick={older} size="sm" variant="ghost">
              Load older runs
            </Button>
          ) : null}
        </section>
      </div>
    </div>
  );
}
