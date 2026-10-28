import type { ConnectorAuthMode } from "@repo/db/shared";
import { type FormEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { getTrpc } from "#/integrations/trpc/client";
import type { ConnectorRecord } from "#/integrations/trpc/types";
import { AuthModeSelect } from "./auth-mode-select";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

export function AuthModeDialog({
  connector,
  onClose,
  onSaved,
}: {
  connector: { id: string; name: string; authMode: ConnectorAuthMode };
  onClose: () => void;
  onSaved: (connector: ConnectorRecord) => void;
}) {
  const [mode, setMode] = useState<ConnectorAuthMode>(connector.authMode);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  const save = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setPending(true);
      setError(null);
      try {
        onSaved(
          await getTrpc().connectors.setAuthMode.mutate({
            authMode: mode,
            connectorId: connector.id,
          })
        );
      } catch (caught) {
        setError(errorMessage(caught));
        setPending(false);
      }
    },
    [connector.id, mode, onSaved]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <form onSubmit={save}>
          <DialogHeader>
            <DialogTitle>Authentication for {connector.name}</DialogTitle>
            <DialogDescription>
              Changing the kind of login removes the logins stored for this
              connector.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <AuthModeSelect
              id="connector-auth-mode-edit"
              onChange={setMode}
              value={mode}
            />
            {error !== null && (
              <p className="text-destructive text-sm">{error}</p>
            )}
            <DialogFooter>
              <Button disabled={pending} type="submit">
                Save
              </Button>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
