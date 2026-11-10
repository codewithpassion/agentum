import { type ChangeEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";

const FALLBACK_AGENT = "agent";

const oneSegment = (part: string): string => part.replaceAll("/", "-");

/** `outputs/<agent>/<file>` as one library path. Slashes in either part become dashes. */
export const defaultLibraryPath = (
  agentName: string,
  fileName: string
): string => {
  const agent = oneSegment(agentName.trim()) || FALLBACK_AGENT;
  return `/outputs/${agent}/${oneSegment(fileName)}`;
};

function SaveToLibraryForm({
  fileId,
  fileName,
  agentName,
  onClose,
}: {
  fileId: string;
  fileName: string;
  agentName: string;
  onClose: () => void;
}) {
  const [path, setPath] = useState(() =>
    defaultLibraryPath(agentName, fileName)
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const handlePathChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setPath(event.target.value);
    },
    []
  );

  const savePath = useCallback(async () => {
    const target = path.trim();
    setPending(true);
    setError(null);
    setSavedPath(null);
    try {
      await getTrpc().files.saveToLibrary.mutate({ fileId, path: target });
      setSavedPath(target);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [fileId, path]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Save to library</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="save-to-library-path">Library path</Label>
          <Input
            data-testid="save-to-library-path"
            id="save-to-library-path"
            onChange={handlePathChange}
            value={path}
          />
        </div>
        {savedPath === null ? null : (
          <p className="text-sm" role="status">
            Saved to {savedPath}
          </p>
        )}
        {error === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            data-testid="save-to-library-submit"
            disabled={pending || path.trim().length === 0}
            onClick={savePath}
          >
            Save
          </Button>
          <Button onClick={onClose} variant="outline">
            Close
          </Button>
        </DialogFooter>
      </div>
    </>
  );
}

export function SaveToLibraryDialog({
  fileId,
  fileName,
  agentName,
  open,
  onOpenChange,
}: {
  fileId: string;
  fileName: string;
  agentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        {/* Radix unmounts the content when the dialog closes, so the form
            starts from the default path each time it opens. */}
        <SaveToLibraryForm
          agentName={agentName}
          fileId={fileId}
          fileName={fileName}
          onClose={handleClose}
        />
      </DialogContent>
    </Dialog>
  );
}
