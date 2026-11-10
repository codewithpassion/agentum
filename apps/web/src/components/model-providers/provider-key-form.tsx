import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { errorMessage } from "#/lib/error-message";
import { keyState } from "./key-state";

export interface ProviderKeyStatus {
  configured: boolean;
  hint: string | null;
  updatedAt: string | null;
}

export interface ProviderKeyFormProps {
  description: string;
  inputId: string;
  onRemove: () => Promise<unknown>;
  onSave: (apiKey: string) => Promise<unknown>;
  placeholder: string;
  status: ProviderKeyStatus;
  title: string;
}

export function ProviderKeyForm({
  title,
  description,
  inputId,
  placeholder,
  status,
  onSave,
  onRemove,
}: ProviderKeyFormProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDraft = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    []
  );

  const saveKey = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const apiKey = draft.trim();
      if (apiKey === "") {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await onSave(apiKey);
        setDraft("");
        toast.success("Key saved");
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [draft, onSave]
  );

  const removeKey = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await onRemove();
      toast.success("Key removed");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [onRemove]);

  return (
    <>
      <h2 className="font-heading text-foreground text-xl">{title}</h2>
      <p className="text-muted-foreground text-sm">{description}</p>
      <p className="text-foreground text-sm">{keyState(status)}</p>
      <form className="flex flex-col gap-4" onSubmit={saveKey}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={inputId}>{title}</FieldLabel>
            <Input
              autoComplete="off"
              disabled={busy}
              id={inputId}
              onChange={handleDraft}
              placeholder={placeholder}
              type="password"
              value={draft}
            />
          </Field>
        </FieldGroup>
        {error === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button disabled={busy || draft.trim() === ""} type="submit">
            Save key
          </Button>
          {status.configured ? (
            <Button
              disabled={busy}
              onClick={removeKey}
              type="button"
              variant="outline"
            >
              Remove key
            </Button>
          ) : null}
        </div>
      </form>
    </>
  );
}
