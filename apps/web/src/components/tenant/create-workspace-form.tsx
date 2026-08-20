import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { TextField } from "#/components/ui/field";
import { createWorkspace } from "#/lib/api";

/**
 * Naming a workspace is the whole of creating one: the slug is derived
 * server-side and the caller becomes its owner. Used both by `/` when a visitor
 * belongs to nothing yet and by the switcher's "Create workspace…".
 */
export function CreateWorkspaceForm({
  autoFocus = false,
  onCreated,
}: {
  autoFocus?: boolean;
  onCreated: (slug: string) => Promise<void> | void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = name.trim();
      if (!trimmed || busy) {
        return;
      }
      setBusy(true);
      setError(null);
      (async () => {
        try {
          const created = await createWorkspace(trimmed);
          await onCreated(created.workspace.slug);
        } catch (cause) {
          // A 502 here is Clerk being unreadable, and its message says so.
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not create the workspace."
          );
        } finally {
          setBusy(false);
        }
      })();
    },
    [busy, name, onCreated]
  );

  return (
    <form className="space-y-3" onSubmit={submit}>
      <TextField
        autoFocus={autoFocus}
        label="Workspace name"
        onChange={onNameChange}
        placeholder="Acme"
        value={name}
      />
      {error ? (
        <p className="m-0 text-[var(--ws-danger)] text-xs">{error}</p>
      ) : null}
      <Button
        disabled={busy || name.trim() === ""}
        type="submit"
        variant="primary"
      >
        {busy ? "Creating…" : "Create workspace"}
      </Button>
    </form>
  );
}
