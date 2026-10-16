import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { formatDistanceToNow } from "date-fns";
import { useCallback, useEffect, useState } from "react";
import { CreateKeyDialog } from "#/components/api-keys/create-key-dialog";
import { SecretDialog } from "#/components/api-keys/secret-dialog";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { getTrpc } from "#/integrations/trpc/client";
import type { ApiKeyRecord } from "#/integrations/trpc/types";

export const Route = createFileRoute("/_app/settings/api-keys")({
  loader: async () => {
    try {
      return await getTrpc().apiKeys.list.query();
    } catch (error) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        throw redirect({ to: "/login" });
      }
      throw error;
    }
  },
  component: ApiKeysPage,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

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
      <TableCell className="font-medium">{keyRecord.name}</TableCell>
      <TableCell className="font-mono text-muted-foreground text-xs">
        {keyRecord.prefix}…
      </TableCell>
      <TableCell>
        <Badge variant={keyRecord.access === "write" ? "default" : "outline"}>
          {keyRecord.access}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {lastUsed(keyRecord)}
      </TableCell>
      <TableCell>
        <Badge variant={active ? "default" : "secondary"}>
          {active ? "active" : "revoked"}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        {active ? (
          <Button onClick={revoke} size="sm" variant="outline">
            Revoke
          </Button>
        ) : null}
      </TableCell>
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
        <Table>
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
        </Table>
      )}
      <div className="mt-8 flex flex-col gap-2">
        <h2 className="font-heading text-foreground text-xl">Use a key</h2>
        <p className="text-muted-foreground text-sm">
          Connect an MCP client with a key in the Authorization header.
        </p>
        {origin === null ? null : (
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-foreground text-xs">
            {`claude mcp add --transport http harbourmaster ${origin}/mcp --header "Authorization: Bearer <your key>"`}
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
