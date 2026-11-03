import { useCallback } from "react";
import { Button } from "#/components/ui/button.tsx";
import type { ComputerChoice } from "./profile-logic.ts";

const PILL_CLASS: Record<ComputerChoice["tone"], string> = {
  bad: "bg-destructive/15 text-destructive",
  good: "bg-success/15 text-success",
  muted: "bg-warning/15 text-warning",
};

/** One computer in the Computer card: its name, status and the attach or detach button. */
export function ComputerChoiceRow({
  choice,
  disabled,
  onChoose,
}: {
  choice: ComputerChoice;
  disabled: boolean;
  /** Receives the machine to attach, or null to detach the attached one. */
  onChoose: (machineId: string | null) => void;
}) {
  const choose = useCallback(
    () => onChoose(choice.attached ? null : choice.id),
    [choice.attached, choice.id, onChoose]
  );
  return (
    <li
      className={`rounded-md border p-3 ${
        choice.attached ? "border-primary bg-primary/5" : "border-border"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-sm">{choice.name}</span>
        <span
          className={`rounded-full px-2 py-0.5 font-semibold text-xs ${PILL_CLASS[choice.tone]}`}
        >
          {choice.status}
        </span>
        {choice.attached ? (
          <span className="rounded-full border border-primary px-2 py-0.5 text-primary text-xs">
            Attached
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">{choice.kind}</p>
        <Button
          disabled={disabled}
          onClick={choose}
          size="sm"
          variant={choice.attached ? "outline" : "default"}
        >
          {choice.attached ? "Detach" : "Attach"}
        </Button>
      </div>
    </li>
  );
}
