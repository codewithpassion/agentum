import { Link } from "@tanstack/react-router";
import { File, Folder, FolderInput, Pencil, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import {
  ResponsiveActions,
  ResponsiveCell,
  ResponsiveTable,
} from "#/components/responsive-table/responsive-table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table.tsx";
import type { LibraryEntryRecord } from "#/integrations/trpc/types";
import {
  baseName,
  breadcrumbs,
  formatMtime,
  formatSize,
} from "./library-logic.ts";
import { LibraryMoveDialog, type MoveMode } from "./library-move-dialog.tsx";

export interface LibraryListProps {
  busyPath: string | null;
  dir: string;
  entries: readonly LibraryEntryRecord[];
  onMoved: (from: string, to: string) => void;
  onRemove: (entry: LibraryEntryRecord) => void;
}

interface EntryRowProps {
  busy: boolean;
  dir: string;
  entry: LibraryEntryRecord;
  onRequestDelete: (entry: LibraryEntryRecord) => void;
  onRequestMove: (entry: LibraryEntryRecord, mode: MoveMode) => void;
}

function Crumbs({ dir }: { dir: string }) {
  const crumbs = breadcrumbs(dir);
  const last = crumbs.length - 1;
  return (
    <nav aria-label="Breadcrumb" className="text-sm">
      <ol className="flex flex-wrap items-center gap-1 text-muted-foreground">
        {crumbs.map((crumb, index) => (
          <li className="flex items-center gap-1" key={crumb.path}>
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {index === last ? (
              <span
                aria-current="page"
                className="text-foreground"
                data-testid="library-crumb"
              >
                {crumb.name}
              </span>
            ) : (
              <Link
                className="hover:underline"
                data-testid="library-crumb"
                search={{ dir: crumb.path === "" ? undefined : crumb.path }}
                to="/library"
              >
                {crumb.name}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function EntryName({ dir, entry }: { dir: string; entry: LibraryEntryRecord }) {
  const name = baseName(entry.path);
  if (entry.kind === "dir") {
    return (
      <Link
        className="inline-flex items-center gap-2 font-medium hover:underline"
        search={{ dir: entry.path }}
        to="/library"
      >
        <Folder aria-hidden="true" className="size-4 shrink-0" />
        {name}
      </Link>
    );
  }
  return (
    <Link
      className="inline-flex items-center gap-2 hover:underline"
      search={{ dir: dir === "" ? undefined : dir, file: entry.path }}
      to="/library"
    >
      <File aria-hidden="true" className="size-4 shrink-0" />
      {name}
    </Link>
  );
}

function EntryRow({
  busy,
  dir,
  entry,
  onRequestDelete,
  onRequestMove,
}: EntryRowProps) {
  const name = baseName(entry.path);
  const requestDelete = useCallback(
    () => onRequestDelete(entry),
    [entry, onRequestDelete]
  );
  const requestRename = useCallback(
    () => onRequestMove(entry, "rename"),
    [entry, onRequestMove]
  );
  const requestMove = useCallback(
    () => onRequestMove(entry, "move"),
    [entry, onRequestMove]
  );
  return (
    <TableRow data-testid="library-row">
      <ResponsiveCell label="Name">
        <EntryName dir={dir} entry={entry} />
      </ResponsiveCell>
      <ResponsiveCell
        className="whitespace-nowrap text-muted-foreground"
        label="Size"
      >
        {entry.kind === "dir" ? "-" : formatSize(entry.size)}
      </ResponsiveCell>
      <ResponsiveCell
        className="whitespace-nowrap text-muted-foreground"
        label="Modified"
      >
        {formatMtime(entry.mtime)}
      </ResponsiveCell>
      <ResponsiveActions className="text-right">
        <Button
          aria-label={`Rename ${name}`}
          data-testid="library-rename"
          disabled={busy}
          onClick={requestRename}
          size="icon-sm"
          variant="ghost"
        >
          <Pencil aria-hidden="true" />
        </Button>
        <Button
          aria-label={`Move ${name}`}
          data-testid="library-move"
          disabled={busy}
          onClick={requestMove}
          size="icon-sm"
          variant="ghost"
        >
          <FolderInput aria-hidden="true" />
        </Button>
        <Button
          aria-label={`Delete ${name}`}
          data-testid="library-delete"
          disabled={busy}
          onClick={requestDelete}
          size="icon-sm"
          variant="ghost"
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </ResponsiveActions>
    </TableRow>
  );
}

function DeleteDialog({
  entry,
  onCancel,
  onConfirm,
}: {
  entry: LibraryEntryRecord | null;
  onCancel: () => void;
  onConfirm: (entry: LibraryEntryRecord) => void;
}) {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onCancel();
      }
    },
    [onCancel]
  );
  const confirm = useCallback(() => {
    if (entry) {
      onConfirm(entry);
    }
  }, [entry, onConfirm]);
  const name = entry ? baseName(entry.path) : "";
  const isFolder = entry?.kind === "dir";
  return (
    <AlertDialog onOpenChange={handleOpenChange} open={entry !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {isFolder
              ? "The folder and everything in it will be deleted."
              : "The file will be deleted."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="library-delete-confirm"
            onClick={confirm}
            variant="destructive"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function LibraryList({
  busyPath,
  dir,
  entries,
  onMoved,
  onRemove,
}: LibraryListProps) {
  const [pending, setPending] = useState<LibraryEntryRecord | null>(null);
  const [moving, setMoving] = useState<{
    entry: LibraryEntryRecord;
    mode: MoveMode;
  } | null>(null);
  const requestMove = useCallback(
    (entry: LibraryEntryRecord, mode: MoveMode) => setMoving({ entry, mode }),
    []
  );
  const closeMove = useCallback(() => setMoving(null), []);
  const requestDelete = useCallback(
    (entry: LibraryEntryRecord) => setPending(entry),
    []
  );
  const cancelDelete = useCallback(() => setPending(null), []);
  const confirmDelete = useCallback(
    (entry: LibraryEntryRecord) => {
      setPending(null);
      onRemove(entry);
    },
    [onRemove]
  );

  return (
    <div className="flex flex-col gap-4">
      <Crumbs dir={dir} />
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">This folder is empty.</p>
      ) : (
        <ResponsiveTable>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Modified</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <EntryRow
                busy={busyPath === entry.path}
                dir={dir}
                entry={entry}
                key={entry.path}
                onRequestDelete={requestDelete}
                onRequestMove={requestMove}
              />
            ))}
          </TableBody>
        </ResponsiveTable>
      )}
      <DeleteDialog
        entry={pending}
        onCancel={cancelDelete}
        onConfirm={confirmDelete}
      />
      <LibraryMoveDialog
        entry={moving?.entry ?? null}
        mode={moving?.mode ?? "rename"}
        onClose={closeMove}
        onMoved={onMoved}
      />
    </div>
  );
}
