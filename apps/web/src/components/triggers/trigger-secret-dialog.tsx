import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { errorMessage } from "./format.ts";

const curlExample = (origin: string, triggerId: string, secret: string) =>
  [
    `curl -X POST "${origin}/api/triggers/${triggerId}" \\`,
    `  -H "Authorization: Bearer ${secret}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '{"text": "Hello from a trigger"}'`,
  ].join("\n");

export function TriggerSecretDialog({
  onDone,
  secret,
  triggerId,
}: {
  onDone: () => void;
  secret: string;
  triggerId: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

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
          <DialogTitle>Trigger created</DialogTitle>
          <DialogDescription>
            Copy this secret now. It is not shown again.
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
        {origin === null ? null : (
          <div className="flex flex-col gap-1.5">
            <p className="text-muted-foreground text-sm">
              Send a message to the agent:
            </p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-foreground text-xs">
              {curlExample(origin, triggerId, secret)}
            </pre>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
