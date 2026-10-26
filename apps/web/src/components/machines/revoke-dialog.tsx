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
import { revokeMachine } from "./machine-logic";

interface RevokeDialogProps {
  machine: { id: string; name: string };
  onClose: () => void;
  onRevoked: () => void;
}

export function RevokeDialog({
  machine,
  onClose,
  onRevoked,
}: RevokeDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!(open || pending)) {
        onClose();
      }
    },
    [onClose, pending]
  );

  const revoke = useCallback(async () => {
    setPending(true);
    setError(null);
    const failure = await revokeMachine(
      (input) => getTrpc().machines.revoke.mutate(input),
      machine.id
    );
    if (failure === null) {
      onRevoked();
      return;
    }
    setError(failure);
    setPending(false);
  }, [machine.id, onRevoked]);

  return (
    <AlertDialog onOpenChange={handleOpenChange} open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {machine.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The machine disconnects at once and can't reconnect. Enrol it again
            to use it later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button disabled={pending} onClick={revoke} variant="destructive">
            Revoke
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
