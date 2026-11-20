import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Field, FieldDescription, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { errorMessage } from "#/lib/error-message.ts";
import { handleError, nameError, normalizeHandle } from "./team-logic.ts";

const HANDLE_HELP =
  "Lowercase letters, digits and single hyphens. Others write @handle to mention you.";
const NO_HANDLE_HINT =
  "You have no handle yet. Set one so people can mention you.";

/** How the team knows the person: a name and a handle, saved through `onSave`. */
export function ProfileForm({
  initial,
  onSave,
}: {
  initial: { handle: string; name: string } | null;
  onSave: (values: { handle: string; name: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initial === null ? "" : initial.name);
  const [handle, setHandle] = useState(initial === null ? "" : initial.handle);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeName = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setName(event.target.value);
  }, []);

  const changeHandle = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setHandle(event.target.value);
  }, []);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSaved(false);
      const cleanHandle = normalizeHandle(handle);
      const problem = nameError(name) ?? handleError(cleanHandle);
      if (problem !== null) {
        setError(problem);
        return;
      }
      setError(null);
      setSaving(true);
      try {
        await onSave({ handle: cleanHandle, name: name.trim() });
        setSaved(true);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setSaving(false);
      }
    },
    [handle, name, onSave]
  );

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      {initial === null ? (
        <p className="text-muted-foreground text-sm">{NO_HANDLE_HINT}</p>
      ) : null}
      <Field>
        <FieldLabel htmlFor="profile-name">Name</FieldLabel>
        <Input
          autoComplete="name"
          id="profile-name"
          onChange={changeName}
          required
          value={name}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="profile-handle">Handle</FieldLabel>
        <FieldDescription id="profile-handle-help">
          {HANDLE_HELP}
        </FieldDescription>
        <div className="flex max-w-xs items-center gap-2">
          <span aria-hidden="true" className="text-muted-foreground">
            @
          </span>
          <Input
            aria-describedby="profile-handle-help"
            autoComplete="off"
            id="profile-handle"
            onChange={changeHandle}
            value={handle}
          />
        </div>
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
        <Button disabled={saving} type="submit">
          Save
        </Button>
      </div>
    </form>
  );
}
