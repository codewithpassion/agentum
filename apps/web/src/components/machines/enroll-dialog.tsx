import { type ChangeEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { getTrpc } from "#/integrations/trpc/client";

interface EnrollToken {
  code: string;
  expiresAt: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

export function EnrollDialog({ onClose }: { onClose: () => void }) {
  const [machineName, setMachineName] = useState("my-machine");
  const [token, setToken] = useState<EnrollToken | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const command = token
    ? `harbourmaster enroll ${token.code} --server ${window.location.origin}`
    : "";

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  const handleNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setMachineName(event.target.value);
    },
    []
  );

  const createCode = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      setToken(
        await getTrpc().machines.createEnrollToken.mutate({ machineName })
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [machineName]);

  const copyCommand = useCallback(async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [command]);

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enrol machine</DialogTitle>
          <DialogDescription>
            {token
              ? "Run this command on the machine you want to enrol."
              : "Name the machine, then create an enrol code for it."}
          </DialogDescription>
        </DialogHeader>

        {token ? (
          <div className="flex flex-col gap-3">
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-foreground text-xs">
              {command}
            </pre>
            <p className="text-muted-foreground text-sm">
              Single use. Expires at{" "}
              {new Date(token.expiresAt).toLocaleTimeString()}.
            </p>
            {error !== null && (
              <p className="text-destructive text-sm">{error}</p>
            )}
            <DialogFooter>
              <Button onClick={copyCommand} variant="outline">
                {copied ? "Copied" : "Copy command"}
              </Button>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="machine-name">Machine name</Label>
              <Input
                id="machine-name"
                onChange={handleNameChange}
                value={machineName}
              />
            </div>
            {error !== null && (
              <p className="text-destructive text-sm">{error}</p>
            )}
            <DialogFooter>
              <Button disabled={pending} onClick={createCode}>
                Create enrol code
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
