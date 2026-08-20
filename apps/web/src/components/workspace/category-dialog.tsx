import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/field";
import { type CategoryView, createCategory, renameCategory } from "#/lib/api";

/** Creates a category, or renames `category` when one is given. */
export function CategoryDialog({
  category,
  onClose,
  onSaved,
  open,
}: {
  category: CategoryView | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  open: boolean;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(category ? category.name : "");
      setError(null);
    }
  }, [open, category]);

  const onNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      try {
        if (category) {
          await renameCategory(category.id, name);
        } else {
          await createCategory(name);
        }
        await onSaved();
        onClose();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to save.");
      } finally {
        setBusy(false);
      }
    },
    [category, name, onClose, onSaved]
  );

  return (
    <Dialog
      onClose={onClose}
      open={open}
      title={category ? "Rename category" : "New category"}
    >
      <form className="space-y-4" onSubmit={submit}>
        <TextField
          hint="Groups channels and agents in the sidebar."
          label="Name"
          maxLength={80}
          onChange={onNameChange}
          placeholder="Product"
          required
          value={name}
        />

        {error ? (
          <p className="m-0 text-[var(--ws-danger)] text-xs">{error}</p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy} type="submit" variant="primary">
            {category ? "Rename" : "Create category"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
