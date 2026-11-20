import { type ChangeEvent, useCallback, useState } from "react";
import { Field, FieldDescription, FieldLabel } from "#/components/ui/field.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select.tsx";
import { errorMessage } from "#/lib/error-message.ts";
import { UNKNOWN_AGENT } from "./team-logic.ts";

const LEAD_HELP =
  "The lead hears room messages that name nobody, and hands the work out.";
const NO_AGENTS_HELP = "Add an agent to the team to choose a lead.";
const NO_LEAD = "No lead.";

/** The team's lead. A change saves at once. */
export function LeadPicker({
  canEdit,
  choices,
  leadId,
  onChange,
}: {
  canEdit: boolean;
  choices: readonly { id: string; label: string }[];
  leadId: string | null;
  onChange: (agentId: string | null) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = useCallback(
    async (event: ChangeEvent<HTMLSelectElement>) => {
      const { value } = event.target;
      setError(null);
      setSaving(true);
      try {
        await onChange(value === "" ? null : value);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setSaving(false);
      }
    },
    [onChange]
  );

  if (!canEdit) {
    if (leadId === null) {
      return <p className="text-sm">{NO_LEAD}</p>;
    }
    const label =
      choices.find((choice) => choice.id === leadId)?.label ?? UNKNOWN_AGENT;
    return <p className="text-sm">Lead: {label}</p>;
  }

  const noChoices = choices.length === 0;
  const helpText = noChoices ? NO_AGENTS_HELP : LEAD_HELP;

  return (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor="team-lead">Lead</FieldLabel>
        <NativeSelect
          aria-describedby="team-lead-help"
          disabled={saving || noChoices}
          id="team-lead"
          onChange={change}
          value={leadId ?? ""}
        >
          <NativeSelectOption value="">No lead</NativeSelectOption>
          {choices.map((choice) => (
            <NativeSelectOption key={choice.id} value={choice.id}>
              {choice.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription id="team-lead-help">{helpText}</FieldDescription>
      </Field>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
