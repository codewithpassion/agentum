import type { RoutineRun, RoutineRunStatus } from "#/lib/api";
import { cx } from "#/lib/cx";
import { formatRelativeTime } from "#/lib/format";

/**
 * One vocabulary for how a run went, shared by the list, the sidebar and the
 * history. The palette is the connectors' and the skills' - accent for "it
 * worked", danger for "it broke", muted for "not yet" - so a dot reads the same
 * wherever it appears.
 */

const STATUS_COLORS: Record<RoutineRunStatus, string> = {
  error: "var(--ws-danger)",
  pending: "var(--ws-muted)",
  posted: "var(--ws-accent)",
};

export const RUN_STATUS_LABELS: Record<RoutineRunStatus, string> = {
  error: "failed",
  pending: "running…",
  posted: "posted",
};

export function RunStatusDot({ run }: { run: RoutineRun }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        run.status === "pending" && "animate-pulse"
      )}
      style={{ background: STATUS_COLORS[run.status] }}
    />
  );
}

/**
 * The dot, when it last ran and how it went. A failure carries its error in the
 * title, so the list stays one line and the reason is still a hover away.
 */
export function LastRunLine({ run }: { run: RoutineRun | null }) {
  if (!run) {
    return (
      <span className="text-[var(--ws-muted)] text-xs">Never run yet</span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[var(--ws-muted)] text-xs"
      data-testid="routine-last-run"
      title={run.error ?? undefined}
    >
      <RunStatusDot run={run} />
      <span>
        {RUN_STATUS_LABELS[run.status]} {formatRelativeTime(run.firedAt)}
      </span>
    </span>
  );
}
