import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { connectHref } from "#/components/connectors/connect-link";
import { connectSearchSchema } from "#/components/connectors/connect-search";
import { PasteCredentialDialog } from "#/components/connectors/paste-credential-dialog";
import {
  ResponsiveActions,
  ResponsiveCell,
  ResponsiveTable,
} from "#/components/responsive-table/responsive-table";
import { signInView } from "#/components/sign-ins/sign-in-logic";
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
import type { MySignInRecord } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";

export const PAGE_HEADING = "Your sign-ins";

export const Route = createFileRoute("/_app/settings/sign-ins")({
  validateSearch: (search) => connectSearchSchema.parse(search),
  loader: async () =>
    loadOrLogin(async () => await getTrpc().connectors.mine.query()),
  component: SignInsPage,
});

function SignInRow({
  item,
  onDisconnected,
  onPaste,
}: {
  item: MySignInRecord;
  onDisconnected: (name: string) => void;
  onPaste: (item: MySignInRecord) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = signInView(item);

  const paste = useCallback(() => onPaste(item), [item, onPaste]);

  const disconnect = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await getTrpc().connectors.removeCredential.mutate({
        connectorId: item.id,
      });
      await router.invalidate();
      onDisconnected(item.name);
    } catch (caught) {
      setError(errorMessage(caught, "Could not disconnect. Try again."));
    } finally {
      setPending(false);
    }
  }, [item, onDisconnected, router]);

  return (
    <TableRow>
      <ResponsiveCell className="font-medium" label="Name">
        {item.name}
        <p className="break-all font-mono text-muted-foreground text-xs">
          {item.url}
        </p>
      </ResponsiveCell>
      <ResponsiveCell label="Status">
        <Badge variant={view.status === "Signed in" ? "default" : "secondary"}>
          {view.status}
        </Badge>
        {view.note === null ? null : (
          <p className="mt-1 text-muted-foreground text-xs">{view.note}</p>
        )}
      </ResponsiveCell>
      <ResponsiveActions className="text-right">
        <div className="flex flex-col items-end gap-1">
          <div className="flex justify-end gap-2">
            {view.action === "connect" ? (
              <Button asChild size="sm" variant="outline">
                <a
                  href={connectHref({
                    as: "user",
                    connectorId: item.id,
                    returnTo: "/settings/sign-ins",
                  })}
                >
                  {view.actionLabel}
                </a>
              </Button>
            ) : null}
            {view.action === "paste" ? (
              <Button onClick={paste} size="sm" variant="outline">
                {view.actionLabel}
              </Button>
            ) : null}
            {view.canDisconnect ? (
              <Button
                aria-label={`Disconnect ${item.name}`}
                disabled={pending}
                onClick={disconnect}
                size="sm"
                variant="outline"
              >
                Disconnect
              </Button>
            ) : null}
          </div>
          {error === null ? null : (
            <p className="text-destructive text-xs">{error}</p>
          )}
        </div>
      </ResponsiveActions>
    </TableRow>
  );
}

function SignInsPage() {
  const items = Route.useLoaderData();
  const search = Route.useSearch();
  const router = useRouter();
  const [pasting, setPasting] = useState<MySignInRecord | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const connectNotice =
    search.connect_error ??
    (search.connected === undefined ? null : "Connected.");

  const openPaste = useCallback((item: MySignInRecord) => setPasting(item), []);

  const closePaste = useCallback(() => setPasting(null), []);

  const handleSaved = useCallback(async () => {
    setPasting(null);
    await router.invalidate();
  }, [router]);

  const handleDisconnected = useCallback((name: string) => {
    setNotice(`Disconnected from ${name}.`);
  }, []);

  return (
    <section className="mx-auto max-w-5xl">
      <h1 className="mb-2 font-heading text-3xl text-foreground">
        {PAGE_HEADING}
      </h1>
      <p className="mb-6 text-muted-foreground text-sm">
        Sign in to the apps your agents use on your behalf. Only you can see or
        remove your own sign-ins.
      </p>
      {connectNotice !== null && (
        <p className="mb-4 text-muted-foreground text-sm">{connectNotice}</p>
      )}
      {notice !== null && (
        <p className="mb-4 text-muted-foreground text-sm">{notice}</p>
      )}
      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No apps yet. An admin adds them under Settings, Apps.
        </p>
      ) : (
        <ResponsiveTable>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <SignInRow
                item={item}
                key={item.id}
                onDisconnected={handleDisconnected}
                onPaste={openPaste}
              />
            ))}
          </TableBody>
        </ResponsiveTable>
      )}
      {pasting === null ? null : (
        <PasteCredentialDialog
          connector={{
            id: pasting.id,
            name: pasting.name,
            headerName: pasting.headerName,
          }}
          onClose={closePaste}
          onSaved={handleSaved}
        />
      )}
    </section>
  );
}
