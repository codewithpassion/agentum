import { createFileRoute, useRouter } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { useCallback, useEffect, useState } from "react";
import { CreateKeyDialog } from "#/components/api-keys/create-key-dialog";
import { SecretDialog } from "#/components/api-keys/secret-dialog";
import { ConfirmButton } from "#/components/confirm-action/confirm-button";
import {
  ResponsiveActions,
  ResponsiveCell,
  ResponsiveTable,
} from "#/components/responsive-table/responsive-table";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";
import type { ApiKeyRecord } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";

export const Route = createFileRoute("/_app/settings/api-keys")({
  loader: async () =>
    loadOrLogin(async () => await getTrpc().apiKeys.list.query()),
  component: ApiKeysPage,
});

function lastUsed(key: ApiKeyRecord): string {
  return key.lastUsedAt
    ? formatDistanceToNow(new Date(key.lastUsedAt), { addSuffix: true })
    : "never";
}

function ApiKeyRow({
  keyRecord,
  onRevoke,
}: {
  keyRecord: ApiKeyRecord;
  onRevoke: (keyId: string) => void;
}) {
  const revoke = useCallback(
    () => onRevoke(keyRecord.id),
    [keyRecord.id, onRevoke]
  );
  const active = keyRecord.revokedAt === null;

  return (
    <TableRow>
      <ResponsiveCell className="font-medium" label="Name">
        {keyRecord.name}
      </ResponsiveCell>
      <ResponsiveCell
        className="font-mono text-muted-foreground text-xs"
        label="Key"
      >
        {keyRecord.prefix}…
      </ResponsiveCell>
      <ResponsiveCell label="Access">
        <Badge
          variant={
            keyRecord.access === "read" || keyRecord.access === "desk"
              ? "outline"
              : "default"
          }
        >
          {keyRecord.access}
        </Badge>
      </ResponsiveCell>
      <ResponsiveCell className="text-muted-foreground" label="Last used">
        {lastUsed(keyRecord)}
      </ResponsiveCell>
      <ResponsiveCell label="Status">
        <Badge variant={active ? "default" : "secondary"}>
          {active ? "active" : "revoked"}
        </Badge>
      </ResponsiveCell>
      <ResponsiveActions className="text-right">
        {active ? (
          <ConfirmButton
            description={`"${keyRecord.name}" stops working at once. Anything using it, such as an MCP client, loses access. This cannot be undone.`}
            onConfirm={revoke}
            size="sm"
            title="Revoke API key?"
            variant="outline"
          >
            Revoke
          </ConfirmButton>
        ) : null}
      </ResponsiveActions>
    </TableRow>
  );
}

function ApiKeysPage() {
  const keys = Route.useLoaderData();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const openCreate = useCallback(() => setCreating(true), []);

  const closeCreate = useCallback(() => setCreating(false), []);

  const showSecret = useCallback((created: string) => {
    setCreating(false);
    setSecret(created);
  }, []);

  const closeSecret = useCallback(() => {
    setSecret(null);
    router.invalidate();
  }, [router]);

  const revokeKey = useCallback(
    async (keyId: string) => {
      setError(null);
      try {
        await getTrpc().apiKeys.revoke.mutate({ keyId });
        await router.invalidate();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [router]
  );

  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-heading text-3xl text-foreground">API keys</h1>
        <Button onClick={openCreate}>Create key</Button>
      </div>
      {error !== null && (
        <p className="mb-4 text-destructive text-sm">{error}</p>
      )}
      {keys.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No API keys yet. Create one to connect an MCP client.
        </p>
      ) : (
        <ResponsiveTable>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Access</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((keyRecord) => (
              <ApiKeyRow
                key={keyRecord.id}
                keyRecord={keyRecord}
                onRevoke={revokeKey}
              />
            ))}
          </TableBody>
        </ResponsiveTable>
      )}
      <div className="mt-8 flex flex-col gap-2">
        <h2 className="font-heading text-foreground text-xl">Use a key</h2>
        <p className="text-muted-foreground text-sm">
          Connect an MCP client with a key in the Authorization header.
        </p>
        {origin === null ? null : (
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-foreground text-xs">
            {`claude mcp add --transport http agentum ${origin}/mcp --header "Authorization: Bearer <your key>"`}
          </pre>
        )}
      </div>
      {creating ? (
        <CreateKeyDialog onClose={closeCreate} onCreated={showSecret} />
      ) : null}
      {secret === null ? null : (
        <SecretDialog onDone={closeSecret} secret={secret} />
      )}
    </section>
  );
}
