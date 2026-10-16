import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

export function SecretDialog({
  onDone,
  secret,
}: {
  onDone: () => void;
  secret: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onDone();
      }
    },
    [onDone]
  );

  const copySecret = useCallback(async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [secret]);

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API key created</DialogTitle>
          <DialogDescription>
            Copy this key now. It is not shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-foreground text-xs">
            {secret}
          </pre>
          {error !== null && (
            <p className="text-destructive text-sm">{error}</p>
          )}
          <DialogFooter>
            <Button onClick={copySecret} variant="outline">
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button onClick={onDone}>Done</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
