import type { ArtifactVersion } from "@repo/protocol/artifacts";
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import { SheetCloseButton } from "../sheet-close";

interface VersionRowProps {
  canRestore: boolean;
  currentNumber: number;
  onRestore: (version: number) => void;
  onView: (version: number) => void;
  shownNumber: number;
  version: ArtifactVersion;
}

function VersionRow({
  canRestore,
  currentNumber,
  onRestore,
  onView,
  shownNumber,
  version,
}: VersionRowProps) {
  const { number } = version;
  const view = useCallback(() => onView(number), [onView, number]);
  const restore = useCallback(() => onRestore(number), [onRestore, number]);

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-sm">
          v{number}
          {number === currentNumber ? " (current)" : ""}
        </span>
        <time
          className="text-muted-foreground text-xs"
          dateTime={version.createdAt}
        >
          {new Date(version.createdAt).toLocaleString()}
        </time>
      </div>
      <p className="text-muted-foreground text-xs">
        {{ agent: "Agent", guest: "Guest", user: "Person" }[version.authorKind]}
        {version.message ? `: ${version.message}` : ""}
      </p>
      {version.authorRunId ? (
        <Link
          className="inline-flex min-h-10 items-center text-xs underline md:min-h-0"
          params={{ runId: version.authorRunId }}
          to="/tasks/$runId"
        >
          Open the task
        </Link>
      ) : null}
      <div className="flex gap-2">
        <Button
          className="h-10 md:h-8"
          disabled={number === shownNumber}
          onClick={view}
          size="sm"
          variant="outline"
        >
          View
        </Button>
        {canRestore && number !== currentNumber ? (
          <Button
            className="h-10 md:h-8"
            onClick={restore}
            size="sm"
            variant="outline"
          >
            Restore
          </Button>
        ) : null}
      </div>
    </li>
  );
}

interface VersionHistorySheetProps {
  canRestore: boolean;
  currentNumber: number;
  onOpenChange: (open: boolean) => void;
  onRestore: (version: number) => void;
  onView: (version: number) => void;
  open: boolean;
  shownNumber: number;
  versions: readonly ArtifactVersion[];
}

export function VersionHistorySheet({
  canRestore,
  currentNumber,
  onOpenChange,
  onRestore,
  onView,
  open,
  shownNumber,
  versions,
}: VersionHistorySheetProps) {
  const [restoring, setRestoring] = useState<number | null>(null);
  const sorted = [...versions].sort((a, b) => b.number - a.number);

  const closeRestore = useCallback((next: boolean) => {
    if (!next) {
      setRestoring(null);
    }
  }, []);
  const confirmRestore = useCallback(() => {
    if (restoring !== null) {
      onRestore(restoring);
    }
    setRestoring(null);
  }, [onRestore, restoring]);

  return (
    <>
      <Sheet onOpenChange={onOpenChange} open={open}>
        <SheetContent
          className="w-full overflow-y-auto sm:max-w-md"
          showCloseButton={false}
        >
          <SheetCloseButton />
          <SheetHeader>
            <SheetTitle>Version history</SheetTitle>
            <SheetDescription>Newest first.</SheetDescription>
          </SheetHeader>
          <ul className="flex flex-col gap-2 px-4 pb-4">
            {sorted.map((version) => (
              <VersionRow
                canRestore={canRestore}
                currentNumber={currentNumber}
                key={version.id}
                onRestore={setRestoring}
                onView={onView}
                shownNumber={shownNumber}
                version={version}
              />
            ))}
          </ul>
        </SheetContent>
      </Sheet>
      <AlertDialog onOpenChange={closeRestore} open={restoring !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore v{restoring}?</AlertDialogTitle>
            <AlertDialogDescription>
              This creates a new version, v{currentNumber + 1}, with the files
              of v{restoring}. History stays as it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRestore}>
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
