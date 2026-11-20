import type { DreamRun, DreamSchedule } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useCallback } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  canUndoRun,
  countsSentence,
  type DreamCardState,
  dreamCardState,
  dreamTitle,
  questionsSentence,
} from "./dream-logic.ts";
import { DreamSchedulePicker } from "./dream-schedule.tsx";
import { SeeChanges } from "./see-changes.tsx";
import type { DreamPending } from "./use-dream.ts";

export interface DreamCardProps {
  agentName: string;
  canChange: boolean;
  /** An archived agent: no button acts. */
  disabled: boolean;
  nowMs: number;
  onRunNow: () => void;
  onSchedule: (schedule: DreamSchedule) => void;
  onUndo: (dreamRunId: string) => void;
  pending: DreamPending | "schedule" | null;
  runs: readonly DreamRun[];
  schedule: DreamSchedule;
}

function UndoNight({
  dreamRunId,
  onUndo,
  pending,
}: {
  dreamRunId: string;
  onUndo: (dreamRunId: string) => void;
  pending: DreamCardProps["pending"];
}): ReactElement {
  const undo = useCallback(() => onUndo(dreamRunId), [dreamRunId, onUndo]);
  return (
    <Button
      disabled={pending !== null}
      onClick={undo}
      size="sm"
      type="button"
      variant="outline"
    >
      {pending === "undo" ? "Undoing…" : "Undo this night"}
    </Button>
  );
}

function DreamBody({
  agentName,
  disabled,
  onUndo,
  pending,
  state,
}: {
  agentName: string;
  disabled: boolean;
  onUndo: (dreamRunId: string) => void;
  pending: DreamCardProps["pending"];
  state: DreamCardState;
}): ReactElement {
  if (state.kind === "none") {
    return (
      <p>
        {`${agentName} has not dreamed yet. A dream reads what happened since the last one, tidies the notes and writes a diary entry here.`}
      </p>
    );
  }
  if (state.kind === "running") {
    return <p>Dreaming now. The diary appears here when it ends.</p>;
  }
  if (state.kind === "skipped") {
    return (
      <p className="whitespace-pre-line break-words">
        {state.run.diary === ""
          ? "Nothing new happened since the last dream, so nothing changed."
          : state.run.diary}
      </p>
    );
  }
  if (state.kind === "failed") {
    return (
      <>
        <p>The dream failed and changed nothing.</p>
        {state.run.error === null ? null : (
          <p className="break-words text-muted-foreground text-sm">
            {state.run.error}
          </p>
        )}
      </>
    );
  }
  if (state.kind === "undone") {
    return (
      <>
        <p>You undid this night. The notes are back as they were.</p>
        <p className="whitespace-pre-line break-words text-muted-foreground">
          {state.run.diary}
        </p>
        <SeeChanges runId={state.run.id} />
      </>
    );
  }
  const questionLine = questionsSentence(state.questions);
  return (
    <>
      <p className="whitespace-pre-line break-words">{state.run.diary}</p>
      <p className="text-muted-foreground text-sm">
        {countsSentence(state.run.counts)}
      </p>
      {questionLine === null ? null : (
        <p className="text-sm">
          {questionLine}{" "}
          <Link className="underline underline-offset-4" to="/desk">
            Answer in Needs you
          </Link>
        </p>
      )}
      <div className="flex flex-col items-start gap-2">
        {canUndoRun(state.run) && !disabled ? (
          <UndoNight
            dreamRunId={state.run.id}
            onUndo={onUndo}
            pending={pending}
          />
        ) : null}
        <SeeChanges runId={state.run.id} />
      </div>
    </>
  );
}

export function DreamCard({
  agentName,
  canChange,
  disabled,
  nowMs,
  onRunNow,
  onSchedule,
  onUndo,
  pending,
  runs,
  schedule,
}: DreamCardProps): ReactElement {
  const state = dreamCardState(runs);
  const heading =
    state.kind === "none" ? "Dreaming" : dreamTitle(state.run.startedAt, nowMs);
  const busy = pending !== null || disabled || state.kind === "running";

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border bg-card p-4"
      data-state={state.kind}
      data-testid="dream-card"
    >
      <h2 className="font-heading text-foreground text-lg">{heading}</h2>
      <DreamBody
        agentName={agentName}
        disabled={disabled}
        onUndo={onUndo}
        pending={pending}
        state={state}
      />
      <div className="flex flex-col gap-3 border-t pt-3">
        {canChange ? (
          <Button
            className="self-start"
            disabled={busy}
            onClick={onRunNow}
            size="sm"
            type="button"
          >
            {pending === "run" ? "Dreaming…" : "Dream now"}
          </Button>
        ) : null}
        <DreamSchedulePicker
          canChange={canChange}
          disabled={busy}
          onChange={onSchedule}
          value={schedule}
        />
      </div>
    </section>
  );
}
