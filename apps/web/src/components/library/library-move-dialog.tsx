import { TRPCClientError } from "@trpc/client";
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
import { getTrpc } from "#/integrations/trpc/client";
import type { LibraryEntryRecord } from "#/integrations/trpc/types";
import {
  baseName,
  errorMessage,
  joinPath,
  parentDir,
} from "./library-logic.ts";

export type MoveMode = "rename" | "move";

export interface LibraryMoveDialogProps {
  entry: LibraryEntryRecord | null;
  mode: MoveMode;
  onClose: () => void;
  onMoved: (from: string, to: string) => void;
}

type Plan = { ok: true; target: string } | { ok: false; message: string };

const LEADING_SLASHES = /^\/+/;
const TRAILING_SLASHES = /\/+$/;

const initialValue = (entry: LibraryEntryRecord, mode: MoveMode): string =>
  mode === "rename" ? baseName(entry.path) : entry.path;

/** The full target path for the input, or the reason it cannot be used. */
const planTarget = (
  entry: LibraryEntryRecord,
  mode: MoveMode,
  input: string
): Plan => {
  if (mode === "rename") {
    const name = input.trim();
    if (name === "") {
      return { message: "Enter a name.", ok: false };
    }
    if (name.includes("/")) {
      return { message: "A name cannot contain /.", ok: false };
    }
    if (name === baseName(entry.path)) {
      return { message: "The name is unchanged.", ok: false };
    }
    return { ok: true, target: joinPath(parentDir(entry.path), name) };
  }
  const path = input
    .trim()
    .replace(LEADING_SLASHES, "")
    .replace(TRAILING_SLASHES, "");
  if (path === "") {
    return { message: "Enter a path.", ok: false };
  }
  if (path === entry.path) {
    return { message: "The path is unchanged.", ok: false };
  }
  return { ok: true, target: path };
};

/** True when nothing exists at `path`. A stat that resolves means it exists. */
const isFree = async (path: string): Promise<boolean> => {
  try {
    await getTrpc().library.stat.query({ path });
    return false;
  } catch (cause) {
    if (cause instanceof TRPCClientError && cause.data?.code === "NOT_FOUND") {
      return true;
    }
    throw cause;
  }
};

function MoveForm({
  entry,
  mode,
  onClose,
  onMoved,
}: {
  entry: LibraryEntryRecord;
  mode: MoveMode;
  onClose: () => void;
  onMoved: (from: string, to: string) => void;
}) {
  const inputId = useId();
  const [value, setValue] = useState(() => initialValue(entry, mode));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = baseName(entry.path);
  const verb = mode === "rename" ? "Rename" : "Move";

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
    []
  );

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const plan = planTarget(entry, mode, value);
      if (!plan.ok) {
        setError(plan.message);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        if (!(await isFree(plan.target))) {
          setError(`${plan.target} already exists.`);
          return;
        }
        await getTrpc().library.move.mutate({
          from: entry.path,
          to: plan.target,
        });
        onMoved(entry.path, plan.target);
        onClose();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [entry, mode, value, onClose, onMoved]
  );

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>
          {verb} {name}
        </DialogTitle>
        <DialogDescription>
          {mode === "rename"
            ? "Pick a new name. The history moves with it."
            : "Type the full new path. Missing folders are created, and the history moves with it."}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <Label htmlFor={inputId}>
          {mode === "rename" ? "New name" : "New path"}
        </Label>
        <Input
          autoComplete="off"
          data-testid="library-move-input"
          id={inputId}
          onChange={handleChange}
          value={value}
        />
      </div>
      {error === null ? null : (
        <p
          className="text-destructive text-sm"
          data-testid="library-move-error"
          role="alert"
        >
          {error}
        </p>
      )}
      <DialogFooter>
        <Button onClick={onClose} type="button" variant="outline">
          Cancel
        </Button>
        <Button data-testid="library-move-submit" disabled={busy} type="submit">
          {verb}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function LibraryMoveDialog({
  entry,
  mode,
  onClose,
  onMoved,
}: LibraryMoveDialogProps) {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );
  return (
    <Dialog onOpenChange={handleOpenChange} open={entry !== null}>
      <DialogContent>
        {entry === null ? null : (
          <MoveForm
            entry={entry}
            key={`${mode}:${entry.path}`}
            mode={mode}
            onClose={onClose}
            onMoved={onMoved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
