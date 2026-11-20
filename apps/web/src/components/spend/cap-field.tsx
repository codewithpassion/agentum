import { useCallback, useState } from "react";
import { errorMessage } from "#/lib/error-message.ts";
import { CapForm } from "./cap-form.tsx";
import { capInputValue, parseCapInput } from "./spend-logic.ts";

/** A weekly limit that saves itself through `onSave`: cents, or null for no limit. */
export function CapField({
  help,
  id,
  label,
  onSave,
  savedCents,
}: {
  help: string;
  id: string;
  label: string;
  onSave: (cents: number | null) => Promise<unknown>;
  savedCents: number | null;
}) {
  const [value, setValue] = useState(capInputValue(savedCents));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = useCallback((next: string) => {
    setSaved(false);
    setValue(next);
  }, []);

  const save = useCallback(async () => {
    const parsed = parseCapInput(value);
    setSaved(false);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(parsed.cents);
      setValue(capInputValue(parsed.cents));
      setSaved(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }, [onSave, value]);

  return (
    <CapForm
      error={error}
      help={help}
      id={id}
      label={label}
      onChange={change}
      onSave={save}
      saved={saved}
      saving={saving}
      value={value}
    />
  );
}
