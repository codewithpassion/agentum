import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
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
import { LibraryHistory } from "./library-history-panel.tsx";

type LibraryEntry = LibraryFileView["entry"];

/** How the panel reads, writes and deletes its file. Build it once per file, since the panel reloads when it changes. */
export interface FilePanelIo {
  /** Left out, the panel shows no download button. */
  downloadHref?: string;
  read: () => Promise<LibraryFileView>;
  remove: () => Promise<void>;
  write: (draft: string, ifEtag: string | undefined) => Promise<LibraryEntry>;
}

const libraryIo = (path: string): FilePanelIo => ({
  downloadHref: downloadUrl(path),
  read: () => getTrpc().library.read.query({ path }),
  remove: async () => {
    await getTrpc().library.remove.mutate({ path });
  },
  write: async (draft, ifEtag) => {
    const entry = await getTrpc().library.write.mutate({
      data: draft,
      encoding: "text",
      ifEtag,
      path,
    });
    return entry;
  },
});

const NOT_EDITABLE =
  "This file is too large or not text, so it opens as a download only.";

/** Words for the save button and its confirmation, for callers that stage a change instead of saving it. */
export interface SaveLabels {
  save: string;
  saved: string;
}

const SAVE_LABELS: SaveLabels = { save: "Save", saved: "Saved." };

interface LibraryFilePanelProps {
  io?: FilePanelIo;
  labels?: SaveLabels;
  onChanged: () => void;
  onClosed: () => void;
  path: string;
  /** Goes up when the page refetches. The panel then checks the file for changes made elsewhere. */
  refreshTick?: number;
}

/** One file of the library: its details, a download, a delete, and a text editor. */
export function LibraryFilePanel({
  io,
  labels = SAVE_LABELS,
  path,
  onChanged,
  onClosed,
  refreshTick = 0,
}: LibraryFilePanelProps) {
  const source = useMemo(() => io ?? libraryIo(path), [io, path]);
  const [file, setFile] = useState<LibraryFileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The newest read from a refresh tick, which differs from `file` when the file changed elsewhere.
  const [remote, setRemote] = useState<LibraryFileView | null>(null);
  // Bumped on every load, so the body remounts with the freshly read draft.
  const [generation, setGeneration] = useState(0);
  // The path this panel shows. Null after unmount, so a late response is dropped.
  const shownPath = useRef<string | null>(null);
  // Bumped by every read, save and adopt, so a refresh read that started earlier is dropped.
  const readSeq = useRef(0);

  useEffect(() => {
    shownPath.current = path;
    return () => {
      shownPath.current = null;
    };
  }, [path]);

  const load = useCallback(async () => {
    readSeq.current += 1;
    try {
      const next = await source.read();
      if (shownPath.current !== path) {
        return;
      }
      setFile(next);
      setRemote(null);
      setError(null);
      setGeneration((count) => count + 1);
    } catch (cause) {
      if (shownPath.current === path) {
        setError(errorMessage(cause));
      }
    }
  }, [path, source]);

  useEffect(() => {
    load();
  }, [load]);

  const checkRemote = useCallback(async () => {
    readSeq.current += 1;
    const seq = readSeq.current;
    try {
      const next = await source.read();
      if (shownPath.current === path && readSeq.current === seq) {
        setRemote(next);
      }
    } catch {
      // A failed refresh keeps what is on screen. The next tick tries again.
    }
  }, [path, source]);

  useEffect(() => {
    if (refreshTick > 0 && io === undefined) {
      checkRemote();
    }
  }, [refreshTick, io, checkRemote]);

  const adoptRemote = useCallback((next: LibraryFileView) => {
    readSeq.current += 1;
    setFile(next);
    setRemote(null);
    setError(null);
    setGeneration((count) => count + 1);
  }, []);

  const saveText = useCallback(
    async (draft: string, ifEtag: string | undefined) => {
      const entry = await source.write(draft, ifEtag);
      if (shownPath.current === path) {
        // Any read from before this save is older than the file now.
        readSeq.current += 1;
        setRemote(null);
        setFile({ entry, text: draft });
        onChanged();
      }
    },
    [path, source, onChanged]
  );

  const restored = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  const remove = useCallback(async () => {
    try {
      await source.remove();
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
  }, [path, source, onChanged, onClosed]);

  return (
    <section className="flex flex-col gap-4">
      {file === null ? null : (
        <FileHeader
          downloadHref={source.downloadHref}
          entry={file.entry}
          onDelete={remove}
          path={path}
        />
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
          labels={labels}
          onAdopt={adoptRemote}
          onReload={load}
          onSave={saveText}
          remote={remote}
        />
      )}
      {io === undefined && file !== null ? (
        <LibraryHistory
          onRestored={restored}
          path={path}
          refreshKey={generation + refreshTick}
        />
      ) : null}
      <div className="flex justify-end">
        <Button onClick={onClosed} type="button" variant="ghost">
          Close
        </Button>
      </div>
    </section>
  );
}

function FileHeader({
  downloadHref,
  entry,
  onDelete,
  path,
}: {
  downloadHref: string | undefined;
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
        {downloadHref === undefined ? null : (
          <a
            className={buttonVariants({ size: "sm", variant: "outline" })}
            data-testid="library-download"
            download
            href={downloadHref}
          >
            Download
          </a>
        )}
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
  labels,
  onAdopt,
  onReload,
  onSave,
  remote,
}: {
  file: LibraryFileView;
  labels: SaveLabels;
  onAdopt: (next: LibraryFileView) => void;
  onReload: () => Promise<void>;
  onSave: (draft: string, ifEtag: string | undefined) => Promise<void>;
  remote: LibraryFileView | null;
}) {
  if (file.text === null) {
    return <p className="text-muted-foreground text-sm">{NOT_EDITABLE}</p>;
  }
  return (
    <TextEditor
      entry={file.entry}
      labels={labels}
      onAdopt={onAdopt}
      onReload={onReload}
      onSave={onSave}
      remote={remote}
      text={file.text}
    />
  );
}

function TextEditor({
  entry,
  labels,
  onAdopt,
  onReload,
  onSave,
  remote,
  text,
}: {
  entry: LibraryEntry;
  labels: SaveLabels;
  onAdopt: (next: LibraryFileView) => void;
  onReload: () => Promise<void>;
  onSave: (draft: string, ifEtag: string | undefined) => Promise<void>;
  remote: LibraryFileView | null;
  text: string;
}) {
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The file changed elsewhere: take the new text when there is nothing unsaved, else offer a reload.
  const changedElsewhere = remote !== null && remote.entry.etag !== entry.etag;
  const clean = draft === text;
  useEffect(() => {
    if (!(changedElsewhere && remote !== null)) {
      return;
    }
    if (clean) {
      onAdopt(remote);
    } else {
      setConflict(true);
    }
  }, [changedElsewhere, clean, remote, onAdopt]);

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
          {labels.save}
        </Button>
        {saved ? (
          <p
            className="text-muted-foreground text-sm"
            data-testid="library-saved"
          >
            {labels.saved}
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
