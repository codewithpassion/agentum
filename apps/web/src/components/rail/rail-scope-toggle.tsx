import type { RailScope } from "@repo/db/shared";
import { useCallback } from "react";
import { cn } from "#/lib/utils";

const SCOPES: readonly { label: string; scope: RailScope }[] = [
  { label: "Mine", scope: "mine" },
  { label: "Everyone", scope: "everyone" },
];

function ScopeButton({
  count,
  label,
  onSelect,
  scope,
  selected,
}: {
  count: number | null;
  label: string;
  onSelect: (scope: RailScope) => void;
  scope: RailScope;
  selected: boolean;
}) {
  const handleClick = useCallback(() => onSelect(scope), [onSelect, scope]);
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-md text-muted-foreground text-sm md:min-h-7",
        selected && "bg-card font-medium text-foreground shadow-xs"
      )}
      onClick={handleClick}
      type="button"
    >
      {label}
      {count === null ? null : (
        <span className="text-muted-foreground text-xs">{count}</span>
      )}
    </button>
  );
}

/** Mine and Everyone, each with its count of things waiting. */
export function ScopeToggle({
  counts,
  onSelect,
  scope,
}: {
  counts: { everyone: number; mine: number } | null;
  onSelect: (scope: RailScope) => void;
  scope: RailScope;
}) {
  return (
    <div className="mx-3 flex gap-0.5 rounded-lg bg-muted p-0.5">
      {SCOPES.map((entry) => (
        <ScopeButton
          count={counts === null ? null : counts[entry.scope]}
          key={entry.scope}
          label={entry.label}
          onSelect={onSelect}
          scope={entry.scope}
          selected={entry.scope === scope}
        />
      ))}
    </div>
  );
}
