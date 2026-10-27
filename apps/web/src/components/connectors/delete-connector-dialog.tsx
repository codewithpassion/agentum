import { useCallback, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

export function DeleteConnectorDialog({
  connector,
  onClose,
  onDeleted,
}: {
  connector: { id: string; name: string };
  onClose: () => void;
  onDeleted: (name: string) => Promise<void>;
}) {
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

  const remove = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await getTrpc().connectors.remove.mutate({ connectorId: connector.id });
      await onDeleted(connector.name);
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }, [connector.id, connector.name, onDeleted]);

  return (
    <AlertDialog onOpenChange={handleOpenChange} open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {connector.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Deleting removes its stored credentials and its assignments to
            agents. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button disabled={pending} onClick={remove} variant="destructive">
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
