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
import { RulesEditor } from "./rules-editor.tsx";
import {
  type RuleDraft,
  rulesReady,
  type SecretRecord,
  toRuleDrafts,
  toRules,
} from "./secret-model.ts";
import { useSecretSubmit } from "./use-secret-submit.ts";

export function EditRulesDialog({
  onClose,
  onDone,
  secret,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
  secret: SecretRecord;
}) {
  const [rules, setRules] = useState<RuleDraft[]>(() =>
    toRuleDrafts(secret.rules)
  );
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
          patch: { mode: "proxy", rules: toRules(rules) },
        });
        toast.success(`Rules of ${secret.name} saved`);
      });
    },
    [rules, secret.id, secret.name, submit]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit rules</DialogTitle>
          <DialogDescription>
            {secret.name} is added as a header to requests to these hosts. Its
            value stays as it is.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <RulesEditor onChange={setRules} rules={rules} />
          {error === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button disabled={pending || !rulesReady(rules)} type="submit">
              Save rules
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
