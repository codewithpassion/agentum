import type { DreamSchedule } from "@repo/db/shared";
import type { ReactElement } from "react";
import { useCallback } from "react";
import { Label } from "#/components/ui/label.tsx";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group.tsx";
import { SCHEDULE_OPTIONS } from "./dream-logic.ts";

const SCHEDULE_LINES: Record<DreamSchedule, string> = {
  nightly: "Dreams nightly.",
  off: "Does not dream on its own.",
  weekly: "Dreams weekly.",
};

export function DreamSchedulePicker({
  canChange,
  disabled,
  onChange,
  value,
}: {
  canChange: boolean;
  disabled: boolean;
  onChange: (schedule: DreamSchedule) => void;
  value: DreamSchedule;
}): ReactElement {
  const changeValue = useCallback(
    (next: string) => {
      const option = SCHEDULE_OPTIONS.find(
        (candidate) => candidate.value === next
      );
      if (option !== undefined) {
        onChange(option.value);
      }
    },
    [onChange]
  );

  if (!canChange) {
    return (
      <p className="text-muted-foreground text-sm">{SCHEDULE_LINES[value]}</p>
    );
  }
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="font-medium text-sm">Dream schedule</legend>
      <RadioGroup disabled={disabled} onValueChange={changeValue} value={value}>
        {SCHEDULE_OPTIONS.map((option) => (
          <Label
            className="flex items-start gap-3 font-normal"
            key={option.value}
          >
            <RadioGroupItem className="mt-0.5" value={option.value} />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{option.label}</span>
              <span className="text-muted-foreground text-xs">
                {option.hint}
              </span>
            </span>
          </Label>
        ))}
      </RadioGroup>
    </fieldset>
  );
}
