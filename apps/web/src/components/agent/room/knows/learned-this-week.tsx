import type { MemoryChange } from "@repo/db/shared";
import { useCallback } from "react";
import { Button } from "#/components/ui/button";
import { changeSentence, changeWhen } from "./learned-logic.ts";
import { NOTES_OWNER_ONLY } from "./notes-logic.ts";

function LearnedRow({
  busy,
  canChange,
  change,
  clamp = false,
  disabled,
  nowMs,
  onUndo,
}: {
  busy: boolean;
  canChange: boolean;
  change: MemoryChange;
  clamp?: boolean;
  disabled: boolean;
  nowMs: number;
  onUndo: (changeId: string) => void;
}) {
  const undo = useCallback(() => onUndo(change.id), [change.id, onUndo]);
  const showUndo = canChange || change.userScope !== null;
  const sentence = changeSentence(change);
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2 py-2"
      data-testid="learned-row"
    >
      <span
        className={clamp ? "line-clamp-3 min-w-0" : undefined}
        title={clamp ? sentence : undefined}
      >
        {sentence},{" "}
        <span className="text-muted-foreground">
          {changeWhen(change.createdAt, nowMs)}
        </span>
      </span>
      {showUndo ? (
        <Button
          disabled={disabled || busy}
          onClick={undo}
          size="sm"
          type="button"
          variant="outline"
        >
          Undo
        </Button>
      ) : null}
    </li>
  );
}

export function LearnedList({
  busyId,
  canChange,
  changes,
  clamp = false,
  disabled,
  nowMs,
  onUndo,
}: {
  busyId: string | null;
  canChange: boolean;
  changes: readonly MemoryChange[];
  /** Clamp each sentence to three lines, with the full text in its title. */
  clamp?: boolean;
  disabled: boolean;
  nowMs: number;
  onUndo: (changeId: string) => void;
}) {
  if (changes.length === 0) {
    return null;
  }
  const someRowHasNoUndo = changes.some(
    (change) => !canChange && change.userScope === null
  );
  return (
    <>
      <ul className="divide-y">
        {changes.map((change) => (
          <LearnedRow
            busy={busyId === change.id}
            canChange={canChange}
            change={change}
            clamp={clamp}
            disabled={disabled}
            key={change.id}
            nowMs={nowMs}
            onUndo={onUndo}
          />
        ))}
      </ul>
      {someRowHasNoUndo ? (
        <p className="pt-2 text-muted-foreground text-xs">{NOTES_OWNER_ONLY}</p>
      ) : null}
    </>
  );
}
