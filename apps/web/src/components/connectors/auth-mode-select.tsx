import type { ConnectorAuthMode } from "@repo/db/shared";
import { type ChangeEvent, useCallback } from "react";
import { Label } from "#/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";

const OPTIONS: { label: string; value: ConnectorAuthMode }[] = [
  { label: "Automatic", value: "auto" },
  { label: "OAuth", value: "oauth" },
  { label: "None", value: "none" },
];

export function AuthModeSelect({
  id,
  onChange,
  value,
}: {
  id: string;
  onChange: (mode: ConnectorAuthMode) => void;
  value: ConnectorAuthMode;
}) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onChange(event.target.value as ConnectorAuthMode);
    },
    [onChange]
  );

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Authentication</Label>
      <NativeSelect id={id} onChange={handleChange} value={value}>
        {OPTIONS.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className="text-muted-foreground text-xs">
        Automatic follows the server&apos;s answer. Choose OAuth when a server
        answers without asking for a login but still needs one.
      </p>
    </div>
  );
}
