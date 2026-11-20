import type { MemoryChange } from "@repo/db/shared";
import { useCallback } from "react";
import { Button } from "#/components/ui/button";
import { changeSentence, changeWhen } from "./learned-logic.ts";

function LearnedRow({
  busy,
  change,
  disabled,
  nowMs,
  onUndo,
}: {
  busy: boolean;
  change: MemoryChange;
  disabled: boolean;
  nowMs: number;
  onUndo: (changeId: string) => void;
}) {
  const undo = useCallback(() => onUndo(change.id), [change.id, onUndo]);
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2 py-2"
      data-testid="learned-row"
    >
      <span>
        {changeSentence(change)},{" "}
        <span className="text-muted-foreground">
          {changeWhen(change.createdAt, nowMs)}
        </span>
      </span>
      <Button
        disabled={disabled || busy}
        onClick={undo}
        size="sm"
        type="button"
        variant="outline"
      >
        Undo
      </Button>
    </li>
  );
}

export function LearnedList({
  busyId,
  changes,
  disabled,
  nowMs,
  onUndo,
}: {
  busyId: string | null;
  changes: readonly MemoryChange[];
  disabled: boolean;
  nowMs: number;
  onUndo: (changeId: string) => void;
}) {
  if (changes.length === 0) {
    return null;
  }
  return (
    <ul className="divide-y">
      {changes.map((change) => (
        <LearnedRow
          busy={busyId === change.id}
          change={change}
          disabled={disabled}
          key={change.id}
          nowMs={nowMs}
          onUndo={onUndo}
        />
      ))}
    </ul>
  );
}
