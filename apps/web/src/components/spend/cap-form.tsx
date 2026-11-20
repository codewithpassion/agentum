import { type ChangeEvent, type FormEvent, useCallback } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";

export interface CapFormProps {
  error: string | null;
  help: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  onSave: () => void;
  saved: boolean;
  saving: boolean;
  /** The cap in dollars as typed. Empty means no cap. */
  value: string;
}

/** A weekly limit in dollars with a Save button. Empty means no limit. */
export function CapForm({
  error,
  help,
  id,
  label,
  onChange,
  onSave,
  saved,
  saving,
  value,
}: CapFormProps) {
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
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex max-w-xs items-center gap-2">
          <span aria-hidden="true" className="text-muted-foreground">
            $
          </span>
          <Input
            aria-describedby={`${id}-help`}
            id={id}
            inputMode="decimal"
            onChange={change}
            placeholder="No limit"
            value={value}
          />
        </div>
        <p className="text-muted-foreground text-sm" id={`${id}-help`}>
          {help}
        </p>
      </div>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {saved ? <p className="text-muted-foreground text-sm">Saved.</p> : null}
      <div>
        <Button disabled={saving} type="submit">
          Save
        </Button>
      </div>
    </form>
  );
}
