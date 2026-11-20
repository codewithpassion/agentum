import { type ChangeEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Field, FieldDescription, FieldLabel } from "#/components/ui/field.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { errorMessage } from "#/lib/error-message.ts";
import { RULES_MAX } from "./team-logic.ts";

const RULES_HELP =
  "Every member reads these before each room message. Posts from the room stay outside them.";
const EMPTY_RULES_TEXT = "No rules yet.";

/**
 * The team's rules: an editor for people who can edit, otherwise the text.
 * The text starts from `rules` and is not synced after mount. After a save
 * the saved rules equal the text, so the editor keeps what was typed.
 */
export function RulesEditor({
  canEdit,
  onSave,
  rules,
}: {
  canEdit: boolean;
  onSave: (rules: string) => Promise<void>;
  rules: string;
}) {
  const [text, setText] = useState(rules);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setSaved(false);
    setError(null);
    setText(event.target.value);
  }, []);

  const save = useCallback(async () => {
    setSaved(false);
    setError(null);
    setSaving(true);
    try {
      await onSave(text);
      setSaved(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }, [onSave, text]);

  if (!canEdit) {
    if (rules.trim() === "") {
      return (
        <p className="text-muted-foreground text-sm">{EMPTY_RULES_TEXT}</p>
      );
    }
    return <p className="whitespace-pre-wrap text-sm">{rules}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor="team-rules">Team rules</FieldLabel>
        <FieldDescription id="team-rules-help">{RULES_HELP}</FieldDescription>
        <Textarea
          aria-describedby="team-rules-help"
          id="team-rules"
          maxLength={RULES_MAX}
          onChange={change}
          rows={8}
          value={text}
        />
      </Field>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {saved ? (
        <p className="text-muted-foreground text-sm" role="status">
          Saved.
        </p>
      ) : null}
      <div>
        <Button
          disabled={saving || text === rules}
          onClick={save}
          type="button"
        >
          Save
        </Button>
      </div>
    </div>
  );
}
