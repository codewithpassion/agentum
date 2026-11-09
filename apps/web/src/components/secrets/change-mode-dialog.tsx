import { SECRET_MODES, type SecretMode } from "@repo/db/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
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
import { Label } from "#/components/ui/label";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group";
import { getTrpc } from "#/integrations/trpc/client";
import { AllowedHostsField } from "./allowed-hosts-field.tsx";
import { RulesEditor } from "./rules-editor.tsx";
import {
  connectorsAtRisk,
  modeChangeDefaults,
  modePatch,
  newHosts,
  type RuleDraft,
  rulesReady,
  type SecretRecord,
} from "./secret-model.ts";
import { useSecretSubmit } from "./use-secret-submit.ts";

const parseMode = (value: string): SecretMode =>
  SECRET_MODES.find((mode) => mode === value) ?? "proxy";

interface LinkedConnector {
  name: string;
  secretId: string | null;
  url: string;
}

/** The names of the connectors linked to the secret, loaded once. A failed load leaves the warning out. */
function useLinkedConnectors(): readonly LinkedConnector[] {
  const [connectors, setConnectors] = useState<readonly LinkedConnector[]>([]);
  useEffect(() => {
    getTrpc()
      .connectors.list.query()
      .then(setConnectors)
      .catch(() => undefined);
  }, []);
  return connectors;
}

export function ChangeModeForm({
  onDone,
  secret,
}: {
  onDone: () => Promise<void>;
  secret: SecretRecord;
}) {
  const [target, setTarget] = useState<SecretMode>(
    secret.mode === "proxy" ? "env" : "proxy"
  );
  const [defaults] = useState(() => modeChangeDefaults(secret));
  const [rules, setRules] = useState<RuleDraft[]>(defaults.rules);
  const [hosts, setHosts] = useState(defaults.hosts);
  const { error, pending, submit } = useSecretSubmit(onDone);
  const connectors = useLinkedConnectors();

  const handleMode = useCallback(
    (next: string) => setTarget(parseMode(next)),
    []
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await submit(async () => {
        await getTrpc().secrets.update.mutate({
          id: secret.id,
          patch: modePatch(target, rules, hosts),
        });
        toast.success(`${secret.name} is now a ${target} secret`);
      });
    },
    [hosts, rules, secret.id, secret.name, submit, target]
  );

  const atRisk = connectorsAtRisk(
    connectors,
    secret.id,
    newHosts(target, rules, hosts)
  );
  const canSubmit =
    !pending &&
    target !== secret.mode &&
    (target === "env" || rulesReady(rules));

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <div className="flex flex-col gap-2">
        <Label>Mode</Label>
        <RadioGroup onValueChange={handleMode} value={target}>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="change-mode-proxy" value="proxy" />
            <Label htmlFor="change-mode-proxy">Proxy</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="change-mode-env" value="env" />
            <Label htmlFor="change-mode-env">Environment variable</Label>
          </div>
        </RadioGroup>
      </div>
      {target === "proxy" ? (
        <RulesEditor onChange={setRules} rules={rules} />
      ) : (
        <AllowedHostsField
          disabled={pending}
          onChange={setHosts}
          value={hosts}
        />
      )}
      {atRisk.length > 0 ? (
        <p
          className="rounded-lg border border-warning/40 bg-warning/15 p-3 text-sm text-warning"
          role="status"
        >
          {atRisk.join(", ")} {atRisk.length === 1 ? "uses" : "use"} this secret
          and would be refused: the hosts above do not include{" "}
          {atRisk.length === 1 ? "its host" : "their hosts"}.
        </p>
      ) : null}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button disabled={!canSubmit} type="submit">
          Change mode
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ChangeModeDialog({
  onClose,
  onDone,
  secret,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
  secret: SecretRecord;
}) {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Change mode</DialogTitle>
          <DialogDescription>
            {secret.name} is a {secret.mode === "proxy" ? "proxy" : "env"}{" "}
            secret. Switch it between proxy and environment variable. Its value
            stays as it is.
          </DialogDescription>
        </DialogHeader>
        <ChangeModeForm onDone={onDone} secret={secret} />
      </DialogContent>
    </Dialog>
  );
}
