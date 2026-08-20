import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/field";

export function NewPageDialog({
  onClose,
  onStart,
  open,
}: {
  onClose: () => void;
  /** Opens the editor for the new page; nothing is stored until it is saved. */
  onStart: (title: string) => void;
  open: boolean;
}) {
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (open) {
      setTitle("");
    }
  }, [open]);

  const onTitleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setTitle(event.target.value),
    []
  );

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      onStart(title.trim());
    },
    [onStart, title]
  );

  return (
    <Dialog onClose={onClose} open={open} title="New page">
      <form className="space-y-3" onSubmit={submit}>
        <TextField
          hint="The address is made from the title and never changes afterwards. Use / to nest: Ops/Runbooks."
          label="Title"
          onChange={onTitleChange}
          placeholder="Getting started"
          value={title}
        />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={title.trim().length === 0}
            type="submit"
            variant="primary"
          >
            Write page
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
