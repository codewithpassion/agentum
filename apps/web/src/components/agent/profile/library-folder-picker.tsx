import { useCallback, useEffect, useState } from "react";
import {
  baseName,
  errorMessage,
  parentDir,
} from "#/components/library/library-logic.ts";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { getTrpc } from "#/integrations/trpc/client";
import { folderPaths } from "./library-access.ts";

function FolderOption({
  onOpen,
  path,
}: {
  onOpen: (path: string) => void;
  path: string;
}) {
  const open = useCallback(() => onOpen(path), [onOpen, path]);
  return (
    <li>
      <Button
        className="w-full justify-start"
        onClick={open}
        size="sm"
        variant="ghost"
      >
        {baseName(path)}
      </Button>
    </li>
  );
}

/** Browses the library's folders and hands back the one the user adds. */
export function LibraryFolderPicker({
  onChoose,
  onOpenChange,
  open,
}: {
  onChoose: (path: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [dir, setDir] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) {
      return;
    }
    let active = true;
    getTrpc()
      .library.list.query({ dir })
      .then((entries) => {
        if (active) {
          setFolders(folderPaths(entries));
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setFolders([]);
          setError(errorMessage(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [dir, open]);

  const up = useCallback(() => setDir(parentDir), []);
  const choose = useCallback(() => onChoose(dir), [dir, onChoose]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add folder</DialogTitle>
          <DialogDescription>
            Pick a library folder. It starts as read only.
          </DialogDescription>
        </DialogHeader>
        <p className="font-mono text-xs">{`/${dir}`}</p>
        {error === undefined ? null : (
          <p className="text-destructive text-xs">{error}</p>
        )}
        <ul className="flex max-h-64 flex-col overflow-y-auto">
          {folders.map((path) => (
            <FolderOption key={path} onOpen={setDir} path={path} />
          ))}
          {folders.length === 0 ? (
            <li className="py-1 text-muted-foreground text-sm">
              No subfolders.
            </li>
          ) : null}
        </ul>
        <div className="flex items-center justify-between gap-2">
          <Button
            disabled={dir === ""}
            onClick={up}
            size="sm"
            variant="outline"
          >
            Up
          </Button>
          <Button disabled={dir === ""} onClick={choose} size="sm">
            Add this folder
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
