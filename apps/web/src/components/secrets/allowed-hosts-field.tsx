import { type ChangeEvent, useCallback } from "react";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";

export function AllowedHostsField({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="secret-allowed-hosts">Allowed hosts</Label>
      <Input
        autoComplete="off"
        disabled={disabled}
        id="secret-allowed-hosts"
        onChange={handleChange}
        placeholder="api.example.com, *.example.org"
        value={value}
      />
      <p className="text-muted-foreground text-xs">
        An isolate agent sees this secret as a placeholder, and the real value
        is filled in only for requests to these hosts, for example
        api.example.com or *.example.com.
      </p>
    </div>
  );
}
