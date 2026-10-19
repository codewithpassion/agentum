import { type FormEvent, useCallback, useState } from "react";
import { toast } from "sonner";
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
import { AllowedHostsField } from "./allowed-hosts-field.tsx";
import { hostsText, parseHosts, type SecretRecord } from "./secret-model.ts";
import { useSecretSubmit } from "./use-secret-submit.ts";

export function EditHostsDialog({
  onClose,
  onDone,
  secret,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
  secret: SecretRecord;
}) {
  const [text, setText] = useState(() => hostsText(secret.allowedHosts));
  const { error, pending, submit } = useSecretSubmit(onDone);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await submit(async () => {
        await getTrpc().secrets.update.mutate({
          id: secret.id,
          patch: { allowedHosts: parseHosts(text) },
        });
        toast.success(`Allowed hosts of ${secret.name} saved`);
      });
    },
    [secret.id, secret.name, submit, text]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit allowed hosts</DialogTitle>
          <DialogDescription>
            {secret.name} is set as a placeholder for isolate agents, and its
            value is filled in only for requests to these hosts. Its value stays
            as it is.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <AllowedHostsField
            disabled={pending}
            onChange={setText}
            value={text}
          />
          {error === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button disabled={pending} type="submit">
              Save hosts
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
