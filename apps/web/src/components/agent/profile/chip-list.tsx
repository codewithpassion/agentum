import { type MouseEvent, type ReactNode, useCallback } from "react";
import type { Chip } from "./profile-logic.ts";

export const TONE_CLASS: Record<Chip["tone"], string> = {
  default: "border-border bg-background text-foreground",
  on: "border-primary bg-primary/10 text-primary",
  warn: "border-warning/40 bg-warning/15 text-warning",
};

export const CHIP_CLASS =
  "inline-flex items-center gap-1.5 whitespace-normal max-md:max-w-full max-md:[overflow-wrap:anywhere] rounded-full border px-2.5 py-0.5 text-xs md:whitespace-nowrap";

/** A row of chips, then the action that opens the manage sheet. */
export function ChipList({
  action,
  chips,
  empty,
  extra,
  note,
  onChipClick,
}: {
  action: { label: string; onClick: () => void };
  chips: readonly Chip[];
  /** Shown when there are no chips. */
  empty?: string;
  /** Rendered after the chips, before the note. */
  extra?: ReactNode;
  note?: string | null;
  /** Makes the "email" chip a button that calls this with its key. */
  onChipClick?: (key: string) => void;
}) {
  const handleChipClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const key = event.currentTarget.dataset.chipKey;
      if (key !== undefined && onChipClick !== undefined) {
        onChipClick(key);
      }
    },
    [onChipClick]
  );

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {chips.length === 0 && empty !== undefined ? (
        <span className="text-muted-foreground text-xs">{empty}</span>
      ) : null}
      {chips.map((chip) =>
        chip.key === "email" && onChipClick !== undefined ? (
          <button
            className={`${CHIP_CLASS} ${TONE_CLASS[chip.tone]} hover:underline`}
            data-chip-key={chip.key}
            key={chip.key}
            onClick={handleChipClick}
            type="button"
          >
            {chip.label}
          </button>
        ) : (
          <span
            className={`${CHIP_CLASS} ${TONE_CLASS[chip.tone]}`}
            key={chip.key}
          >
            {chip.label}
          </span>
        )
      )}
      {extra}
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
