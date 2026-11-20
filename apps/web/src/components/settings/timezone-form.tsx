import { type ChangeEvent, type FormEvent, useCallback } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";

export interface TimezoneFormProps {
  error: string | null;
  isAdmin: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  saved: boolean;
  saving: boolean;
  value: string;
}

export function TimezoneForm({
  error,
  isAdmin,
  onChange,
  onSave,
  saved,
  saving,
  value,
}: TimezoneFormProps) {
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      onSave();
    },
    [onSave]
  );

  if (!isAdmin) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-foreground text-sm">Workspace timezone: {value}</p>
        <p className="text-muted-foreground text-sm">An admin sets this.</p>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="workspace-timezone">Workspace timezone</Label>
        <Input
          aria-describedby="workspace-timezone-help"
          id="workspace-timezone"
          onChange={change}
          placeholder="Europe/Zurich"
          value={value}
        />
        <p
          className="text-muted-foreground text-sm"
          id="workspace-timezone-help"
        >
          Routines read their schedules in this zone unless a routine sets its
          own.
        </p>
      </div>
      {error === null ? null : (
        <p className="text-destructive text-sm">{error}</p>
      )}
      {saved ? <p className="text-muted-foreground text-sm">Saved.</p> : null}
      <div>
        <Button disabled={saving || value.trim() === ""} type="submit">
          Save
        </Button>
      </div>
    </form>
  );
}
