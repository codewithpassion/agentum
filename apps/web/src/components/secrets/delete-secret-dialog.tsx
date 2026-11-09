import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
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
import type { SecretRecord } from "./secret-model.ts";
import { useSecretSubmit } from "./use-secret-submit.ts";

export function DeleteSecretDialog({
  onClose,
  onDone,
  secret,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
  secret: SecretRecord;
}) {
  const [connectorNames, setConnectorNames] = useState<string[]>([]);
  const [usageError, setUsageError] = useState(false);
  useEffect(() => {
    getTrpc()
      .connectors.list.query()
      .then((rows) =>
        setConnectorNames(
          rows
            .filter((row) => row.secretId === secret.id)
            .map((row) => row.name)
        )
      )
      .catch(() => setUsageError(true));
  }, [secret.id]);
  const { error, pending, submit } = useSecretSubmit(onDone);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  const remove = useCallback(
    () =>
      submit(async () => {
        await getTrpc().secrets.remove.mutate({ id: secret.id });
        toast.success(`Secret ${secret.name} deleted`);
      }),
    [secret.id, secret.name, submit]
  );

  return (
    <AlertDialog onOpenChange={handleOpenChange} open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {secret.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The value is deleted for good, and every agent loses this secret.
            {connectorNames.length > 0 &&
              ` These connectors will need a secret: ${connectorNames.join(", ")}.`}
            {usageError === true && " Could not load connector usage."}
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
