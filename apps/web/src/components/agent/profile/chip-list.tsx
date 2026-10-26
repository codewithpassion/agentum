import type { Chip } from "./profile-logic.ts";

const TONE_CLASS: Record<Chip["tone"], string> = {
  default: "border-border bg-background text-foreground",
  on: "border-primary bg-primary/10 text-primary",
  warn: "border-amber-400 bg-amber-100 text-amber-900",
};

const CHIP_CLASS =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs";

/** A row of chips, then the action that opens the manage sheet. */
export function ChipList({
  action,
  chips,
  empty,
  note,
}: {
  action: { label: string; onClick: () => void };
  chips: readonly Chip[];
  /** Shown when there are no chips. */
  empty?: string;
  note?: string | null;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {chips.length === 0 && empty !== undefined ? (
        <span className="text-muted-foreground text-xs">{empty}</span>
      ) : null}
      {chips.map((chip) => (
        <span
          className={`${CHIP_CLASS} ${TONE_CLASS[chip.tone]}`}
          key={chip.key}
        >
          {chip.label}
        </span>
      ))}
      {note === null || note === undefined ? null : (
        <span className="text-muted-foreground text-xs">{note}</span>
      )}
      <button
        className={`${CHIP_CLASS} border-dashed text-muted-foreground hover:text-foreground`}
        onClick={action.onClick}
        type="button"
      >
        {action.label}
      </button>
    </span>
  );
}
