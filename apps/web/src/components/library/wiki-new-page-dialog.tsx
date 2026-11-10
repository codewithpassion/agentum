import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useId,
  useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { WikiPageNodeRecord } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import { wikiParentOptions } from "./wiki-logic.ts";

export interface WikiNewPageDialogProps {
  initialTitle: string;
  nodes: readonly WikiPageNodeRecord[];
  onClose: () => void;
  onCreated: (path: string) => void;
  open: boolean;
}

function NewPageForm({
  initialTitle,
  nodes,
  onClose,
  onCreated,
}: Omit<WikiNewPageDialogProps, "open">) {
  const titleId = useId();
  const parentId = useId();
  const [title, setTitle] = useState(initialTitle);
  const [parent, setParent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = wikiParentOptions(nodes);
  const canSubmit = title.trim() !== "" && !busy;

  const handleTitleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setTitle(event.target.value),
    []
  );

  const handleParentChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => setParent(event.target.value),
    []
  );

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const page = await getTrpc().wiki.createPage.mutate({
          parent: parent === "" ? undefined : parent,
          title: title.trim(),
        });
        onCreated(page.path);
        onClose();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [parent, title, onClose, onCreated]
  );

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>New page</DialogTitle>
        <DialogDescription>
          The address comes from the title, and a / in the title nests the page:
          Ops/Runbooks.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <Label htmlFor={titleId}>Title</Label>
        <Input
          autoComplete="off"
          data-testid="wiki-new-title"
          id={titleId}
          onChange={handleTitleChange}
          value={title}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={parentId}>Parent</Label>
        <NativeSelect
          data-testid="wiki-new-parent"
          id={parentId}
          onChange={handleParentChange}
          value={parent}
        >
          {options.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {error === null ? null : (
        <p
          className="text-destructive text-sm"
          data-testid="wiki-new-error"
          role="alert"
        >
          {error}
        </p>
      )}
      <DialogFooter>
        <Button onClick={onClose} type="button" variant="outline">
          Cancel
        </Button>
        <Button
          data-testid="wiki-new-submit"
          disabled={!canSubmit}
          type="submit"
        >
          Create page
        </Button>
      </DialogFooter>
    </form>
  );
}

export function WikiNewPageDialog({
  initialTitle,
  nodes,
  onClose,
  onCreated,
  open,
}: WikiNewPageDialogProps) {
  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        onClose();
      }
    },
    [onClose]
  );
  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent>
        {open ? (
          <NewPageForm
            initialTitle={initialTitle}
            key={initialTitle}
            nodes={nodes}
            onClose={onClose}
            onCreated={onCreated}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
