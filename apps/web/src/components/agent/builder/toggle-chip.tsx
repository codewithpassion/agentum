import type { ProfileGap } from "@repo/db/shared";
import type { AgentDraft } from "@repo/services/agent-builder/draft";
import { useCallback } from "react";
import { isLocked, type Locked } from "./builder-logic.ts";

const CHIP_BASE =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs";
const CHIP_ON = "border-primary bg-primary/10 text-primary";
const CHIP_WARN = "border-amber-400 bg-amber-100 text-amber-900";
const CHIP_DEFAULT = "border-border bg-background text-foreground";

const toneClass = (selected: boolean, warn: boolean): string => {
  if (selected) {
    return CHIP_ON;
  }
  return warn ? CHIP_WARN : CHIP_DEFAULT;
};

/** A chip that switches on or off. `warn` marks an unselected chip as needing a choice. */
export function ToggleChip({
  id,
  label,
  onToggle,
  selected,
  warn = false,
}: {
  id: string;
  label: string;
  onToggle: (id: string) => void;
  selected: boolean;
  warn?: boolean;
}) {
  const click = useCallback(() => onToggle(id), [id, onToggle]);
  return (
    <button
      aria-pressed={selected}
      className={`${CHIP_BASE} ${toneClass(selected, warn)}`}
      onClick={click}
      type="button"
    >
      {label}
    </button>
  );
}

/** A chip that can be taken off the draft. The parent gets its index. */
export function RemovableChip({
  index,
  label,
  onRemove,
}: {
  index: number;
  label: string;
  onRemove: (index: number) => void;
}) {
  const remove = useCallback(() => onRemove(index), [index, onRemove]);
  return (
    <span className={`${CHIP_BASE} ${CHIP_DEFAULT}`}>
      {label}
      <button
        aria-label={`Remove ${label}`}
        className="text-muted-foreground hover:text-foreground"
        onClick={remove}
        type="button"
      >
        ×
      </button>
    </span>
  );
}

/** The open questions for one row, as yellow chips. */
export function GapNote({ gaps }: { gaps: readonly ProfileGap[] }) {
  return (
    <>
      {gaps.map((gap) => (
        <span
          className={`${CHIP_BASE} ${CHIP_WARN}`}
          key={`${gap.field}:${gap.question}`}
        >
          {gap.question}
        </span>
      ))}
    </>
  );
}

/** Marks a field the person edited, so a redraft keeps it. */
export function KeptNote({
  field,
  locked,
}: {
  field: keyof AgentDraft;
  locked: Locked;
}) {
  if (!isLocked(locked, field)) {
    return null;
  }
  return <span className="text-muted-foreground text-xs">kept</span>;
}
