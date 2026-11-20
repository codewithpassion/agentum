import type { DreamDecision, DreamRun, DreamSchedule } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useCallback } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  canUndoRun,
  countsSentence,
  currentDiary,
  type DreamCardState,
  decisionPending,
  dreamCardState,
  dreamTitle,
  questionsLine,
} from "./dream-logic.ts";
import { DreamSchedulePicker } from "./dream-schedule.tsx";
import { HeldBatch } from "./held-batch.tsx";
import { SeeChanges } from "./see-changes.tsx";
import type { DreamPending } from "./use-dream.ts";

export interface DreamCardProps {
  agentName: string;
  canChange: boolean;
  /** An archived agent: no button acts. */
  disabled: boolean;
  nowMs: number;
  onDecide: (dreamRunId: string, decision: DreamDecision) => void;
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

function QuestionsLine({ run }: { run: DreamRun }): ReactElement | null {
  const line = questionsLine(run);
  if (line === null) {
    return null;
  }
  return (
    <p className="text-sm">
      {line.text}
      {line.open ? (
        <>
          {" "}
          <Link className="underline underline-offset-4" to="/desk">
            Open Needs you
          </Link>
        </>
      ) : null}
    </p>
  );
}

function DreamBody({
  agentName,
  canChange,
  disabled,
  onDecide,
  onUndo,
  pending,
  state,
}: {
  agentName: string;
  canChange: boolean;
  disabled: boolean;
  onDecide: (dreamRunId: string, decision: DreamDecision) => void;
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
      <p className="whitespace-pre-line [overflow-wrap:anywhere]">
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
          <p className="text-muted-foreground text-sm [overflow-wrap:anywhere]">
            {state.run.error}
          </p>
        )}
      </>
    );
  }
  if (state.kind === "held") {
    return (
      <>
        <p className="whitespace-pre-line [overflow-wrap:anywhere]">
          {currentDiary(state.run)}
        </p>
        <QuestionsLine run={state.run} />
        <HeldBatch
          canDecide={canChange}
          disabled={
            disabled || (pending !== null && decisionPending(pending) === null)
          }
          dreamRunId={state.run.id}
          onDecide={onDecide}
          pending={decisionPending(pending)}
        />
      </>
    );
  }
  if (state.kind === "rejected") {
    return (
      <>
        <p className="whitespace-pre-line [overflow-wrap:anywhere]">
          {currentDiary(state.run)}
        </p>
        <QuestionsLine run={state.run} />
        <SeeChanges runId={state.run.id} />
      </>
    );
  }
  if (state.kind === "undone") {
    return (
      <>
        <p>You undid this night. The notes are back as they were.</p>
        <p className="whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">
          {currentDiary(state.run)}
        </p>
        <SeeChanges runId={state.run.id} />
      </>
    );
  }
  const diary = currentDiary(state.run);
  const counts = countsSentence(state.run.counts);
  return (
    <>
      <p className="whitespace-pre-line [overflow-wrap:anywhere]">{diary}</p>
      {diary.startsWith(counts) ? null : (
        <p className="text-muted-foreground text-sm">{counts}</p>
      )}
      <QuestionsLine run={state.run} />
      <div className="flex flex-col items-start gap-2">
        {canChange && canUndoRun(state.run) && !disabled ? (
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
  onDecide,
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
        canChange={canChange}
        disabled={disabled}
        onDecide={onDecide}
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
