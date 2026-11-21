import { useCallback, useState } from "react";
import { Field, FieldDescription, FieldLabel } from "#/components/ui/field.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { errorMessage } from "#/lib/error-message.ts";

export const LEAD_LISTENS_HELP =
  "The lead hears room messages that name nobody, and hands the work out.";

/** Whether the lead hears room messages that name nobody. A change saves at once. */
export function LeadListensSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (leadListens: boolean) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = useCallback(
    async (next: boolean) => {
      setError(null);
      setSaving(true);
      try {
        await onChange(next);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setSaving(false);
      }
    },
    [onChange]
  );

  return (
    <div className="flex flex-col gap-3">
      <Field orientation="horizontal">
        <Switch
          aria-describedby="team-lead-listens-help"
          checked={checked}
          disabled={saving}
          id="team-lead-listens"
          onCheckedChange={change}
        />
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor="team-lead-listens">Lead listens</FieldLabel>
          <FieldDescription id="team-lead-listens-help">
            {LEAD_LISTENS_HELP}
          </FieldDescription>
        </div>
      </Field>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
