import { SECRET_MODES, type SecretMode } from "@repo/db/shared";
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
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group";
import { getTrpc } from "#/integrations/trpc/client";
import { RulesEditor } from "./rules-editor.tsx";
import {
  emptyRule,
  type RuleDraft,
  rulesReady,
  toRules,
} from "./secret-model.ts";
import { useSecretSubmit } from "./use-secret-submit.ts";

const parseMode = (value: string): SecretMode =>
  SECRET_MODES.find((mode) => mode === value) ?? "proxy";

export function CreateSecretDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<SecretMode>("proxy");
  const [rules, setRules] = useState<RuleDraft[]>(() => [emptyRule()]);
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

  const handleName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );

  const handleValue = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
    []
  );

  const handleMode = useCallback(
    (next: string) => setMode(parseMode(next)),
    []
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await submit(async () => {
        await getTrpc().secrets.create.mutate(
          mode === "proxy"
            ? { mode: "proxy", name, rules: toRules(rules), value }
            : { mode: "env", name, value }
        );
        setValue("");
        toast.success(`Secret ${name.trim()} created`);
      });
    },
    [mode, name, rules, submit, value]
  );

  const canSubmit =
    !pending &&
    name.trim() !== "" &&
    value !== "" &&
    (mode === "env" || rulesReady(rules));

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New secret</DialogTitle>
          <DialogDescription>
            The value is encrypted and never shown again.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="secret-name">Name</Label>
            <Input
              autoComplete="off"
              disabled={pending}
              id="secret-name"
              onChange={handleName}
              placeholder="OPENAI_API_KEY"
              value={name}
            />
            <p className="text-muted-foreground text-xs">
              Letters, digits and underscores, e.g. OPENAI_API_KEY.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="secret-value">Value</Label>
            <Input
              autoComplete="off"
              disabled={pending}
              id="secret-value"
              onChange={handleValue}
              type="password"
              value={value}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Mode</Label>
            <RadioGroup onValueChange={handleMode} value={mode}>
              <div className="flex items-center gap-2">
                <RadioGroupItem id="secret-mode-proxy" value="proxy" />
                <Label htmlFor="secret-mode-proxy">Proxy</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id="secret-mode-env" value="env" />
                <Label htmlFor="secret-mode-env">Env</Label>
              </div>
            </RadioGroup>
          </div>
          {mode === "proxy" ? (
            <RulesEditor onChange={setRules} rules={rules} />
          ) : null}
          {error === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button disabled={!canSubmit} type="submit">
              Create secret
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
