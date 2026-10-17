import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
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
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { getTrpc } from "#/integrations/trpc/client";
import type { SecretRecord } from "./secret-model.ts";
import { useSecretSubmit } from "./use-secret-submit.ts";

export function ReplaceValueDialog({
  onClose,
  onDone,
  secret,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
  secret: SecretRecord;
}) {
  const [value, setValue] = useState("");
  const { error, pending, submit } = useSecretSubmit(onDone);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setValue("");
        onClose();
      }
    },
    [onClose]
  );

  const handleValue = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
    []
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await submit(async () => {
        await getTrpc().secrets.update.mutate({
          id: secret.id,
          patch: { value },
        });
        setValue("");
        toast.success(`Value of ${secret.name} replaced`);
      });
    },
    [secret.id, secret.name, submit, value]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replace value</DialogTitle>
          <DialogDescription>
            The old value of {secret.name} is discarded. The new value is
            encrypted and never shown again.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="replace-secret-value">New value</Label>
            <Input
              autoComplete="off"
              disabled={pending}
              id="replace-secret-value"
              onChange={handleValue}
              type="password"
              value={value}
            />
          </div>
          {error === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button disabled={pending || value === ""} type="submit">
              Replace value
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
