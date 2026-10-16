import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  baseName,
  downloadUrl,
  errorMessage,
  formatMtime,
  formatSize,
  isConflict,
} from "#/components/library/library-logic.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button, buttonVariants } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";
import type { LibraryFileView } from "#/integrations/trpc/types";

type LibraryEntry = LibraryFileView["entry"];

const NOT_EDITABLE =
  "This file is too large or not text, so it opens as a download only.";

interface LibraryFilePanelProps {
  onChanged: () => void;
  onClosed: () => void;
  path: string;
}

/** One file of the library: its details, a download, a delete, and a text editor. */
export function LibraryFilePanel({
  path,
  onChanged,
  onClosed,
}: LibraryFilePanelProps) {
  const [file, setFile] = useState<LibraryFileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every load, so the body remounts with the freshly read draft.
  const [generation, setGeneration] = useState(0);
  // The path this panel shows. Null after unmount, so a late response is dropped.
  const shownPath = useRef<string | null>(null);

  useEffect(() => {
    shownPath.current = path;
    return () => {
      shownPath.current = null;
    };
  }, [path]);

  const load = useCallback(async () => {
    try {
      const next = await getTrpc().library.read.query({ path });
      if (shownPath.current !== path) {
        return;
      }
      setFile(next);
      setError(null);
      setGeneration((count) => count + 1);
    } catch (cause) {
      if (shownPath.current === path) {
        setError(errorMessage(cause));
      }
    }
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);

  const saveText = useCallback(
    async (draft: string, ifEtag: string | undefined) => {
      const entry = await getTrpc().library.write.mutate({
        data: draft,
        encoding: "text",
        ifEtag,
        path,
      });
      if (shownPath.current === path) {
        setFile({ entry, text: draft });
        onChanged();
      }
    },
    [path, onChanged]
  );

  const remove = useCallback(async () => {
    try {
      await getTrpc().library.remove.mutate({ path });
    } catch (cause) {
      if (shownPath.current === path) {
        setError(errorMessage(cause));
      }
      return;
    }
    if (shownPath.current === path) {
      onChanged();
      onClosed();
    }
  }, [path, onChanged, onClosed]);

  return (
    <section className="flex flex-col gap-4">
      {file === null ? null : (
        <FileHeader entry={file.entry} onDelete={remove} path={path} />
      )}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {file === null && error === null ? (
        <p className="text-muted-foreground text-sm">Loading...</p>
      ) : null}
      {file === null ? null : (
        <FileBody
          file={file}
          key={generation}
          onReload={load}
          onSave={saveText}
        />
      )}
      <div className="flex justify-end">
        <Button onClick={onClosed} type="button" variant="ghost">
          Close
        </Button>
      </div>
    </section>
  );
}

function FileHeader({
  entry,
  onDelete,
  path,
}: {
  entry: LibraryEntry;
  onDelete: () => Promise<void>;
  path: string;
}) {
  const name = baseName(path);
  return (
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="truncate font-medium">{name}</h2>
        <p className="text-muted-foreground text-sm">
          {formatSize(entry.size)} · {formatMtime(entry.mtime)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <a
          className={buttonVariants({ size: "sm", variant: "outline" })}
          data-testid="library-download"
          download
          href={downloadUrl(path)}
        >
          Download
        </a>
        <DeleteFile name={name} onConfirm={onDelete} />
      </div>
    </header>
  );
}

function DeleteFile({
  name,
  onConfirm,
}: {
  name: string;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => setOpen(true), []);
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <Button
        data-testid="library-delete-file"
        onClick={openDialog}
        size="sm"
        type="button"
        variant="destructive"
      >
        Delete
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The file will be deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="library-delete-file-confirm"
            onClick={onConfirm}
            variant="destructive"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function FileBody({
  file,
  onReload,
  onSave,
}: {
  file: LibraryFileView;
  onReload: () => Promise<void>;
  onSave: (draft: string, ifEtag: string | undefined) => Promise<void>;
}) {
  if (file.text === null) {
    return <p className="text-muted-foreground text-sm">{NOT_EDITABLE}</p>;
  }
  return (
    <TextEditor
      entry={file.entry}
      onReload={onReload}
      onSave={onSave}
      text={file.text}
    />
  );
}

function TextEditor({
  entry,
  onReload,
  onSave,
  text,
}: {
  entry: LibraryEntry;
  onReload: () => Promise<void>;
  onSave: (draft: string, ifEtag: string | undefined) => Promise<void>;
  text: string;
}) {
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    setConflict(false);
    setError(null);
    try {
      await onSave(draft, entry.etag ?? undefined);
      setSaved(true);
    } catch (cause) {
      if (isConflict(cause)) {
        setConflict(true);
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setSaving(false);
    }
  }, [draft, entry.etag, onSave]);

  const edit = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
    setSaved(false);
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <textarea
        aria-label="File contents"
        className="w-full rounded-lg border border-input bg-transparent p-2.5 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        data-testid="library-editor"
        onChange={edit}
        rows={24}
        spellCheck={false}
        value={draft}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          data-testid="library-save"
          disabled={draft === text || saving}
          onClick={save}
          type="button"
        >
          Save
        </Button>
        {saved ? (
          <p
            className="text-muted-foreground text-sm"
            data-testid="library-saved"
          >
            Saved.
          </p>
        ) : null}
      </div>
      {conflict ? (
        <div className="flex flex-wrap items-center gap-3">
          <p
            className="text-destructive text-sm"
            data-testid="library-conflict"
            role="alert"
          >
            This file changed since you opened it.
          </p>
          <Button
            data-testid="library-reload"
            onClick={onReload}
            size="sm"
            type="button"
            variant="outline"
          >
            Reload
          </Button>
        </div>
      ) : null}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
