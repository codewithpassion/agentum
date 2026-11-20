import type { DreamDecision, DreamRun } from "@repo/db/shared";
import type { ReactElement } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { changeWhen } from "../learned-logic.ts";
import {
  countsSentence,
  earlierRuns,
  RUN_STATUS_LABELS,
} from "./dream-logic.ts";
import { HeldBatch } from "./held-batch.tsx";
import { SeeChanges } from "./see-changes.tsx";

/** The line under an earlier dream's badge, or null when it has none. */
function detailOf(run: DreamRun): string | null {
  if (run.status === "done" && run.heldChanges > 0) {
    return run.diary === "" ? null : run.diary;
  }
  if (run.status === "done") {
    return countsSentence(run.counts);
  }
  if (run.status === "skipped") {
    return run.diary === "" ? null : run.diary;
  }
  if (run.status === "failed") {
    return run.error;
  }
  return null;
}

function capitalised(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function EarlierDream({
  canChange,
  disabled,
  nowMs,
  onDecide,
  pending,
  run,
}: {
  canChange: boolean;
  disabled: boolean;
  nowMs: number;
  onDecide: (dreamRunId: string, decision: DreamDecision) => void;
  pending: DreamDecision | null;
  run: DreamRun;
}): ReactElement {
  const held = run.status === "done" && run.heldChanges > 0;
  const detail = detailOf(run);
  const hasChanges = run.status === "done" || run.status === "undone";
  return (
    <li className="flex flex-col gap-1 py-2" data-testid="earlier-dream">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">
          {capitalised(changeWhen(run.startedAt, nowMs))}
        </span>
        <Badge variant="secondary">
          {held ? "Held" : RUN_STATUS_LABELS[run.status]}
        </Badge>
      </div>
      {detail === null ? null : (
        <p className="whitespace-pre-line text-muted-foreground text-sm">
          {detail}
        </p>
      )}
      {held ? (
        <HeldBatch
          canDecide={canChange}
          disabled={disabled}
          dreamRunId={run.id}
          onDecide={onDecide}
          pending={pending}
        />
      ) : null}
      {hasChanges && !held ? <SeeChanges runId={run.id} /> : null}
    </li>
  );
}

export function EarlierDreams({
  canChange,
  disabled,
  nowMs,
  onDecide,
  pending,
  runs,
}: {
  canChange: boolean;
  /** Nothing acts: an archived agent, or another action is under way. */
  disabled: boolean;
  nowMs: number;
  onDecide: (dreamRunId: string, decision: DreamDecision) => void;
  /** The decision being sent, or null. */
  pending: DreamDecision | null;
  runs: readonly DreamRun[];
}): ReactElement | null {
  const earlier = earlierRuns(runs);
  if (earlier.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-sm">Earlier dreams</h3>
      <ul className="divide-y" data-testid="earlier-dreams">
        {earlier.map((run) => (
          <EarlierDream
            canChange={canChange}
            disabled={disabled}
            key={run.id}
            nowMs={nowMs}
            onDecide={onDecide}
            pending={pending}
            run={run}
          />
        ))}
      </ul>
    </section>
  );
}
