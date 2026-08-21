import { useCallback } from "react";
import { SelectField } from "#/components/ui/field";
import { modelLabel } from "#/lib/model-format";
import { AVAILABLE_MODELS } from "#/modules/anthropic/config";

/**
 * The model picker, shared by the agent dialog and the routine form. The two
 * differ only in what "unset" means - the workspace default for an agent, the
 * agent's own model for a routine - so naming that option is the caller's job.
 *
 * Unset is the empty string in the DOM and `null` on the wire, which is what
 * both APIs take to mean "put this back on the default".
 */
export function ModelSelect({
  defaultLabel,
  hint,
  onChange,
  testId,
  value,
}: {
  /** What the "no model of its own" option is called. */
  defaultLabel: string;
  hint?: string;
  onChange: (model: string | null) => void;
  testId: string;
  /** A catalog id, or null for the default. */
  value: string | null;
}) {
  const change = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) =>
      onChange(event.target.value || null),
    [onChange]
  );

  // A stored model the catalog no longer offers keeps its own option, or
  // opening the form would silently re-point the row at whichever model
  // happens to come first.
  const staleOption =
    value !== null && !AVAILABLE_MODELS.some((model) => model.id === value) ? (
      <option value={value}>{modelLabel(value)}</option>
    ) : null;

  return (
    <SelectField
      data-testid={testId}
      hint={hint}
      label="Model"
      onChange={change}
      value={value ?? ""}
    >
      <option value="">{defaultLabel}</option>
      {staleOption}
      {AVAILABLE_MODELS.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label}
        </option>
      ))}
    </SelectField>
  );
}
