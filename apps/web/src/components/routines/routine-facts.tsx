import type { Routine } from "#/lib/api";
import { modelLabel } from "#/lib/model-format";
import { formatInZone, formatUntil } from "#/lib/schedule-format";

/**
 * The two facts every view of a routine repeats: what it points at, and when it
 * fires next. A target the workspace no longer has is shown as broken rather
 * than hidden - the routine still exists and still needs fixing or deleting.
 */

function Missing({ what }: { what: string }) {
  return (
    <span
      className="text-[var(--ws-danger)]"
      title={`This ${what} was deleted`}
    >
      (deleted {what})
    </span>
  );
}

export function TargetLine({ routine }: { routine: Routine }) {
  return (
    <p className="m-0 text-[var(--ws-muted)] text-xs">
      {routine.agentName ?? <Missing what="agent" />}
      {" → "}
      {routine.channelName ? (
        `# ${routine.channelName}`
      ) : (
        <Missing what="channel" />
      )}
      {/* Only a routine that overrides its agent's model says which one. */}
      {routine.model === null ? null : (
        <span data-testid="routine-model-fact">
          {" "}
          · {modelLabel(routine.model)}
        </span>
      )}
    </p>
  );
}

export function NextRunLine({ routine }: { routine: Routine }) {
  if (!routine.enabled) {
    return (
      <span className="text-[var(--ws-muted)] text-xs" data-testid="next-run">
        Paused
      </span>
    );
  }
  if (routine.nextRunAt === null) {
    return (
      <span className="text-[var(--ws-danger)] text-xs" data-testid="next-run">
        No future run
      </span>
    );
  }
  return (
    <span className="text-[var(--ws-muted)] text-xs" data-testid="next-run">
      Next {formatUntil(routine.nextRunAt)} ·{" "}
      {formatInZone(routine.nextRunAt, routine.timezone)}
    </span>
  );
}
