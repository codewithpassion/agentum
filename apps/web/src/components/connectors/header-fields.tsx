import { useAuth } from "@clerk/tanstack-react-start";
import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import { CreateSecretDialog } from "#/components/secrets/create-secret-dialog";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { getTrpc } from "#/integrations/trpc/client";

export interface HeaderDraft {
  headerName: string;
  headerTemplate: string;
  secretId: string | null;
}

export function HeaderFields({
  value,
  onChange,
  url,
}: {
  value: HeaderDraft;
  onChange: (value: HeaderDraft) => void;
  url: string;
}) {
  const { orgRole } = useAuth();
  const isAdmin = orgRole === "org:admin";
  const [secrets, setSecrets] = useState<{ id: string; name: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (isAdmin) {
      getTrpc()
        .secrets.list.query()
        .then(setSecrets)
        .catch(() => setError("Could not load workspace secrets."));
    }
  }, [isAdmin]);
  const created = useCallback(
    (secret: { id: string; name: string }) => {
      setSecrets((previous) => [...previous, secret]);
      onChange({ ...value, secretId: secret.id });
    },
    [onChange, value]
  );
  const done = useCallback(() => {
    setCreating(false);
    return Promise.resolve();
  }, []);
  const changeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange({ ...value, headerName: event.target.value }),
    [onChange, value]
  );
  const changeTemplate = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange({ ...value, headerTemplate: event.target.value }),
    [onChange, value]
  );
  const changeSecret = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      onChange({ ...value, secretId: event.target.value || null }),
    [onChange, value]
  );
  const openCreate = useCallback(() => setCreating(true), []);
  const closeCreate = useCallback(() => setCreating(false), []);
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // The URL may still be being typed.
  }
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="connector-header-name">Header name</Label>
        <Input
          id="connector-header-name"
          onChange={changeName}
          value={value.headerName}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="connector-header-template">Value</Label>
        <Input
          id="connector-header-template"
          maxLength={512}
          onChange={changeTemplate}
          value={value.headerTemplate}
        />
        <p className="text-muted-foreground text-xs">
          {"{value}"} is where the key goes. Used when a workspace secret is
          linked.
        </p>
      </div>
      {isAdmin ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="connector-secret">Secret</Label>
          <NativeSelect
            id="connector-secret"
            onChange={changeSecret}
            value={value.secretId ?? ""}
          >
            <NativeSelectOption value="">
              Personal or agent credential
            </NativeSelectOption>
            {secrets.map((secret) => (
              <NativeSelectOption key={secret.id} value={secret.id}>
                {secret.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            disabled={!host}
            onClick={openCreate}
            type="button"
            variant="outline"
          >
            New secret
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          An admin can link a workspace secret
        </p>
      )}
      {error !== null && <p className="text-destructive text-sm">{error}</p>}
      {creating === true && (
        <CreateSecretDialog
          initialHosts={host}
          initialMode="env"
          onClose={closeCreate}
          onCreated={created}
          onDone={done}
        />
      )}
    </>
  );
}
