import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useState } from "react";
import {
  type ConnectedAppAccess,
  ConnectedAppsTable,
} from "#/components/connected-apps/connected-apps-table";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app/settings/connected-apps")({
  loader: async () => {
    try {
      return await getTrpc().oauthClients.list.query();
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
  component: ConnectedAppsPage,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

function ConnectedAppsPage() {
  const clients = Route.useLoaderData();
  const router = useRouter();
  const [busyClientId, setBusyClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const change = useCallback(
    async (clientId: string, write: () => Promise<unknown>) => {
      setError(null);
      setBusyClientId(clientId);
      try {
        await write();
        await router.invalidate();
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusyClientId(null);
      }
    },
    [router]
  );

  const setAccess = useCallback(
    (clientId: string, access: ConnectedAppAccess) =>
      change(clientId, () =>
        getTrpc().oauthClients.setAccess.mutate({ clientId, access })
      ),
    [change]
  );

  const revoke = useCallback(
    (clientId: string) =>
      change(clientId, () =>
        getTrpc().oauthClients.revoke.mutate({ clientId })
      ),
    [change]
  );

  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-heading text-3xl text-foreground">
          Connected apps
        </h1>
      </div>
      {error !== null && (
        <p className="mb-4 text-destructive text-sm">{error}</p>
      )}
      {clients.length === 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">
            No apps yet. An app appears here after it first tries to connect.
          </p>
          <p className="text-muted-foreground text-sm">
            To connect Claude.ai, add a custom connector in Claude.ai with this
            server&apos;s MCP URL:
          </p>
          {origin === null ? null : (
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-foreground text-xs">
              {`${origin}/mcp`}
            </pre>
          )}
        </div>
      ) : (
        <ConnectedAppsTable
          busyClientId={busyClientId}
          clients={clients}
          onRevoke={revoke}
          onSetAccess={setAccess}
        />
      )}
    </section>
  );
}
