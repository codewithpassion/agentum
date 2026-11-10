import { useCallback, useEffect, useRef, useState } from "react";
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
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";
import type { LibraryVersionRecord } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import { type DiffLine, formatMtime, lineDiff } from "./library-logic.ts";

const MAX_COMPARED = 2;
const NOT_TEXT = "These versions are not text, so they cannot be compared.";

const DIFF_PREFIX: Record<DiffLine["kind"], string> = {
  add: "+ ",
  del: "- ",
  same: "  ",
};

const DIFF_CLASS: Record<DiffLine["kind"], string> = {
  add: "bg-green-500/15",
  del: "bg-red-500/15",
  same: "text-muted-foreground",
};

interface KeyedLine extends DiffLine {
  key: number;
}

interface Comparison {
  lines: KeyedLine[];
  newer: number;
  older: number;
}

export interface LibraryHistoryProps {
  onRestored: () => void;
  path: string;
  refreshKey: number;
}

/** The version history of one library file: compare two text versions, or restore an older one. */
export function LibraryHistory({
  path,
  refreshKey,
  onRestored,
}: LibraryHistoryProps) {
  const [versions, setVersions] = useState<LibraryVersionRecord[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // Bumped on every selection change, so a late compare is dropped. The parent keys the file panel by path, so a new file starts clean.
  const epoch = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey only triggers a refetch
  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const rows = await getTrpc().library.versions.query({ path });
        if (current) {
          setVersions(rows);
          setError(null);
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
  }, [path, refreshKey]);

  const toggle = useCallback((id: string) => {
    epoch.current += 1;
    setComparison(null);
    setCompareError(null);
    setComparing(false);
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id].slice(-MAX_COMPARED)
    );
  }, []);

  const compare = useCallback(async () => {
    const [first, second] = selected;
    if (first === undefined || second === undefined) {
      return;
    }
    const token = epoch.current;
    setComparing(true);
    setComparison(null);
    setCompareError(null);
    try {
      const [left, right] = await Promise.all([
        getTrpc().library.readVersion.query({ versionId: first }),
        getTrpc().library.readVersion.query({ versionId: second }),
      ]);
      if (token !== epoch.current) {
        return;
      }
      const [older, newer] =
        left.version.version <= right.version.version
          ? [left, right]
          : [right, left];
      if (older.text === null || newer.text === null) {
        setCompareError(NOT_TEXT);
        return;
      }
      setComparison({
        lines: lineDiff(older.text, newer.text).map((line, key) => ({
          ...line,
          key,
        })),
        newer: newer.version.version,
        older: older.version.version,
      });
    } catch (cause) {
      if (token === epoch.current) {
        setCompareError(errorMessage(cause));
      }
    } finally {
      if (token === epoch.current) {
        setComparing(false);
      }
    }
  }, [selected]);

  const restore = useCallback(
    async (versionId: string) => {
      setRestoreError(null);
      try {
        await getTrpc().library.restore.mutate({ versionId });
      } catch (cause) {
        setRestoreError(errorMessage(cause));
        return;
      }
      // The panel rereads the file, which bumps refreshKey and so refetches the history.
      onRestored();
    },
    [onRestored]
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">History</h3>
        <Button
          data-testid="library-compare"
          disabled={selected.length !== MAX_COMPARED || comparing}
          onClick={compare}
          size="sm"
          type="button"
          variant="outline"
        >
          Compare
        </Button>
      </div>
      {compareError === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {compareError}
        </p>
      )}
      {comparison === null ? null : <DiffView comparison={comparison} />}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {restoreError === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {restoreError}
        </p>
      )}
      <VersionList
        error={error}
        onRestore={restore}
        onToggle={toggle}
        selected={selected}
        versions={versions}
      />
    </section>
  );
}

function VersionList({
  error,
  onRestore,
  onToggle,
  selected,
  versions,
}: {
  error: string | null;
  onRestore: (versionId: string) => Promise<void>;
  onToggle: (versionId: string) => void;
  selected: string[];
  versions: LibraryVersionRecord[] | null;
}) {
  if (versions === null) {
    return error === null ? (
      <p className="text-muted-foreground text-sm">Loading...</p>
    ) : null;
  }
  if (versions.length === 0) {
    return <p className="text-muted-foreground text-sm">No history yet.</p>;
  }
  return (
    <ol className="flex flex-col divide-y">
      {versions.map((version, position) => (
        <HistoryRow
          canRestore={position > 0 && version.op !== "delete"}
          checked={selected.includes(version.id)}
          key={version.id}
          onRestore={onRestore}
          onToggle={onToggle}
          version={version}
        />
      ))}
    </ol>
  );
}

interface HistoryRowProps {
  canRestore: boolean;
  checked: boolean;
  onRestore: (versionId: string) => Promise<void>;
  onToggle: (versionId: string) => void;
  version: LibraryVersionRecord;
}

function HistoryRow({
  canRestore,
  checked,
  onRestore,
  onToggle,
  version,
}: HistoryRowProps) {
  const toggleThis = useCallback(
    () => onToggle(version.id),
    [onToggle, version.id]
  );
  const restoreThis = useCallback(
    () => onRestore(version.id),
    [onRestore, version.id]
  );
  const author =
    version.authorKind === "agent"
      ? `Agent ${version.authorId}`
      : version.authorId;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="flex min-w-0 items-center gap-3">
        {version.op === "delete" ? null : (
          <input
            aria-label={`Select v${version.version} to compare`}
            checked={checked}
            className="size-4"
            onChange={toggleThis}
            type="checkbox"
          />
        )}
        <div className="flex min-w-0 flex-col">
          <p className="text-sm">
            v{version.version} · {version.op}
          </p>
          <p className="text-muted-foreground text-xs">
            {author} · {formatMtime(version.createdAt)}
          </p>
        </div>
      </div>
      {canRestore ? (
        <RestoreVersion number={version.version} onConfirm={restoreThis} />
      ) : null}
    </li>
  );
}

function RestoreVersion({
  number,
  onConfirm,
}: {
  number: number;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => setOpen(true), []);
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <Button
        data-testid="library-restore"
        onClick={openDialog}
        size="sm"
        type="button"
        variant="outline"
      >
        Restore
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore v{number}?</AlertDialogTitle>
          <AlertDialogDescription>
            The file goes back to this version. The current content stays in the
            history. Unsaved edits in the editor are discarded.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="library-restore-confirm"
            onClick={onConfirm}
          >
            Restore
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DiffView({ comparison }: { comparison: Comparison }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium text-sm">
        v{comparison.older} to v{comparison.newer}
      </p>
      <pre
        className="max-h-96 overflow-auto rounded-lg border border-input p-2.5 font-mono text-sm"
        data-testid="library-diff"
      >
        {comparison.lines.map((line) => (
          <DiffLineRow key={line.key} line={line} />
        ))}
      </pre>
    </div>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  return (
    <div className={DIFF_CLASS[line.kind]}>
      {DIFF_PREFIX[line.kind]}
      {line.text}
    </div>
  );
}
