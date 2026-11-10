import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
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
import { errorMessage } from "#/lib/error-message";

export function OAuthClientDialog({
  connector,
  onClose,
  onSaved,
}: {
  connector: { id: string; name: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
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

  const handleClientIdChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setClientId(event.target.value);
    },
    []
  );

  const handleClientSecretChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setClientSecret(event.target.value);
    },
    []
  );

  const save = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const secret = clientSecret.trim();
      setPending(true);
      setError(null);
      try {
        await getTrpc().connectors.setOAuthClient.mutate({
          clientId: clientId.trim(),
          connectorId: connector.id,
          ...(secret.length > 0 ? { clientSecret: secret } : {}),
        });
        onSaved();
      } catch (caught) {
        setError(errorMessage(caught));
        setPending(false);
      }
    },
    [clientId, clientSecret, connector.id, onSaved]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <form onSubmit={save}>
          <DialogHeader>
            <DialogTitle>OAuth client for {connector.name}</DialogTitle>
            <DialogDescription>
              This server does not register clients on its own. Enter the client
              id (and secret) from its documentation.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-client-id">Client ID</Label>
              <Input
                autoComplete="off"
                id="oauth-client-id"
                onChange={handleClientIdChange}
                value={clientId}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="oauth-client-secret">
                Client secret (optional)
              </Label>
              <Input
                autoComplete="off"
                id="oauth-client-secret"
                onChange={handleClientSecretChange}
                type="password"
                value={clientSecret}
              />
            </div>
            {error !== null && (
              <p className="text-destructive text-sm">{error}</p>
            )}
            <DialogFooter>
              <Button
                disabled={pending || clientId.trim().length === 0}
                type="submit"
              >
                Save
              </Button>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
