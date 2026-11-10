import { File, Folder } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  baseName,
  formatSize,
  parentDir,
} from "#/components/library/library-logic.ts";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { LibraryEntryRecord } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";

export interface LibraryPickerProps {
  /** Called when the dialog closes without a pick. */
  onClose: () => void;
  /** Called with the library path of the file the person picked. */
  onPick: (path: string) => void;
}

interface EntryButtonProps {
  entry: LibraryEntryRecord;
  onOpen: (entry: LibraryEntryRecord) => void;
}

function EntryButton({ entry, onOpen }: EntryButtonProps) {
  const open = useCallback(() => onOpen(entry), [entry, onOpen]);
  return (
    <Button
      className="justify-start"
      data-testid="library-picker-entry"
      onClick={open}
      type="button"
      variant="ghost"
    >
      {entry.kind === "dir" ? (
        <Folder aria-hidden="true" />
      ) : (
        <File aria-hidden="true" />
      )}
      <span className="truncate">{baseName(entry.path)}</span>
      {entry.kind === "file" ? (
        <span className="ml-auto text-muted-foreground text-xs">
          {formatSize(entry.size)}
        </span>
      ) : null}
    </Button>
  );
}

/**
 * Browses the library one folder at a time and picks a single file. Mounted
 * only while open, so each opening starts at the root.
 */
export function LibraryPicker({ onPick, onClose }: LibraryPickerProps) {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<LibraryEntryRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A reply for a folder the person has already left is dropped.
    let current = true;
    const load = async () => {
      setEntries(null);
      setError(null);
      try {
        const result = await getTrpc().library.list.query({ dir });
        if (current) {
          setEntries(result);
        }
      } catch (cause) {
        if (current) {
          setError(errorMessage(cause));
        }
      }
    };
    load();
    return () => {
      current = false;
    };
  }, [dir]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  const handleOpen = useCallback(
    (entry: LibraryEntryRecord) => {
      if (entry.kind === "dir") {
        setDir(entry.path);
      } else {
        onPick(entry.path);
      }
    },
    [onPick]
  );

  const goUp = useCallback(() => setDir(parentDir(dir)), [dir]);

  let body: ReactNode;
  if (error !== null) {
    body = (
      <p className="text-destructive text-sm" role="alert">
        {error}
      </p>
    );
  } else if (entries === null) {
    body = <p className="text-muted-foreground text-sm">Loading...</p>;
  } else if (entries.length === 0) {
    body = (
      <p className="text-muted-foreground text-sm">This folder is empty.</p>
    );
  } else {
    body = (
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => (
          <li key={entry.path}>
            <EntryButton entry={entry} onOpen={handleOpen} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Dialog defaultOpen onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach from library</DialogTitle>
          <DialogDescription>
            Pick a file to attach to this message.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          {dir === "" ? null : (
            <Button
              data-testid="library-picker-up"
              onClick={goUp}
              size="sm"
              type="button"
              variant="outline"
            >
              Up
            </Button>
          )}
          <p className="truncate text-muted-foreground text-sm">
            {dir || "Library"}
          </p>
        </div>
        <div className="max-h-80 overflow-y-auto">{body}</div>
      </DialogContent>
    </Dialog>
  );
}
