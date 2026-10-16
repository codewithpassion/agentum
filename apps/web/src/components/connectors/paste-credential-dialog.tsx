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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

export function PasteCredentialDialog({
  agent,
  connector,
  onClose,
  onSaved,
}: {
  agent?: { id: string; name: string };
  connector: { id: string; name: string; headerName: string | null };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const header = connector.headerName ?? "Authorization";
  const owner = agent ? `as ${agent.name}` : "as yourself";

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  const handleValueChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setValue(event.target.value);
    },
    []
  );

  const save = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await getTrpc().connectors.setCredential.mutate({
        connectorId: connector.id,
        value: value.trim(),
        ...(agent ? { agentId: agent.id } : {}),
      });
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }, [agent, connector.id, onSaved, value]);

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Paste credential for {connector.name}</DialogTitle>
          <DialogDescription>
            Saved {owner}. Paste the whole {header} header value, for example
            Bearer abc123.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="credential-value">Header value</Label>
            <Input
              autoComplete="off"
              id="credential-value"
              onChange={handleValueChange}
              type="password"
              value={value}
            />
          </div>
          <p className="text-muted-foreground text-sm">
            The value is stored encrypted and is not shown again.
          </p>
          {error !== null && (
            <p className="text-destructive text-sm">{error}</p>
          )}
          <DialogFooter>
            <Button
              disabled={pending || value.trim().length === 0}
              onClick={save}
            >
              Save
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
