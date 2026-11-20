import { type ChangeEvent, type FormEvent, useCallback } from "react";
import { Button } from "#/components/ui/button";
import { Field, FieldLabel } from "#/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";

/** A labelled select of choices with an Add button. The caller owns the choice and the submit. */
export function AddMemberForm({
  busy,
  choice,
  choices,
  onChange,
  onSubmit,
  placeholder,
  selectId,
  title,
}: {
  busy: boolean;
  choice: string;
  choices: readonly { id: string; label: string }[];
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  placeholder: string;
  selectId: string;
  title: string;
}) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value),
    [onChange]
  );
  return (
    <form className="flex flex-col gap-2" onSubmit={onSubmit}>
      <Field>
        <FieldLabel htmlFor={selectId}>{title}</FieldLabel>
        <div className="flex items-center gap-2">
          <NativeSelect
            className="min-w-0 flex-1"
            disabled={busy}
            id={selectId}
            onChange={handleChange}
            value={choice}
          >
            <NativeSelectOption value="">{placeholder}</NativeSelectOption>
            {choices.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>
                {entry.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            disabled={busy || choice === ""}
            size="sm"
            type="submit"
            variant="outline"
          >
            Add
          </Button>
        </div>
      </Field>
    </form>
  );
}
