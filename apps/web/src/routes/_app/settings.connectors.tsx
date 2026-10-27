import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useState } from "react";
import { AddConnectorDialog } from "#/components/connectors/add-connector-dialog";
import { CallTimeoutDialog } from "#/components/connectors/call-timeout-dialog";
import { connectHref } from "#/components/connectors/connect-link";
import { connectSearchSchema } from "#/components/connectors/connect-search";
import { DeleteConnectorDialog } from "#/components/connectors/delete-connector-dialog";
import { OAuthClientDialog } from "#/components/connectors/oauth-client-dialog";
import { PasteCredentialDialog } from "#/components/connectors/paste-credential-dialog";
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
import type {
  ConnectorRecord,
  CredentialRecord,
} from "#/integrations/trpc/types";

export const Route = createFileRoute("/_app/settings/connectors")({
  validateSearch: (search) => connectSearchSchema.parse(search),
  loader: async () => {
    try {
      return await getTrpc().connectors.list.query();
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
  component: ConnectorsPage,
});

const AUTH_LABEL: Record<ConnectorRecord["authKind"], string> = {
  header: "header",
  none: "none",
  oauth: "OAuth",
};

const STATUS_LABEL: Record<ConnectorRecord["status"], string> = {
  needs_auth: "needs auth",
  ok: "ok",
};

const OAUTH_CREDENTIAL_LABEL: Record<CredentialRecord["status"], string> = {
  needs_auth: "needs auth",
  ok: "connected",
  revoked: "revoked",
};

function addedMessage(connector: ConnectorRecord): string {
  switch (connector.authKind) {
    case "header":
      return "Added. The server wants a header: paste a credential next.";
    case "oauth":
      return "Added. This server uses OAuth.";
    case "none":
      return "Added. No credential needed.";
    default:
      return "Added.";
  }
}

function credentialLabel(connector: ConnectorRecord): string {
  if (connector.authKind !== "header") {
    return "-";
  }
  return connector.myCredential === null ? "none" : "pasted";
}

function OAuthCredential({ connector }: { connector: ConnectorRecord }) {
  const credential = connector.myCredential;
  if (credential === null) {
    return <span>none</span>;
  }
  return (
    <Badge variant={credential.status === "ok" ? "default" : "secondary"}>
      {OAUTH_CREDENTIAL_LABEL[credential.status]}
    </Badge>
  );
}

function OAuthActions({
  connector,
  onSetClient,
}: {
  connector: ConnectorRecord;
  onSetClient: (connector: ConnectorRecord) => void;
}) {
  const setClient = useCallback(
    () => onSetClient(connector),
    [connector, onSetClient]
  );
  const { oauth } = connector;

  const canConnect =
    oauth !== null && (oauth.clientConfigured || oauth.canRegister);
  const href = connectHref({
    as: "user",
    connectorId: connector.id,
    returnTo: "/settings/connectors",
  });
  return (
    <div className="flex justify-end gap-2">
      {canConnect ? (
        <Button asChild size="sm" variant="outline">
          <a href={href}>
            {connector.myCredential === null ? "Connect" : "Re-authorise"}
          </a>
        </Button>
      ) : null}
      <Button onClick={setClient} size="sm" variant="outline">
        Set client
      </Button>
    </div>
  );
}

function ConnectorRow({
  connector,
  onDelete,
  onEditTimeout,
  onPaste,
  onSetClient,
}: {
  connector: ConnectorRecord;
  onDelete: (connector: ConnectorRecord) => void;
  onEditTimeout: (connector: ConnectorRecord) => void;
  onPaste: (connector: ConnectorRecord) => void;
  onSetClient: (connector: ConnectorRecord) => void;
}) {
  const paste = useCallback(() => onPaste(connector), [connector, onPaste]);
  const editTimeout = useCallback(
    () => onEditTimeout(connector),
    [connector, onEditTimeout]
  );
  const remove = useCallback(() => onDelete(connector), [connector, onDelete]);
  const toolNames = connector.tools.map((tool) => tool.name).join(", ");

  return (
    <TableRow>
      <ResponsiveCell className="font-medium" label="Name">
        {connector.name}
      </ResponsiveCell>
      <ResponsiveCell
        className="font-mono text-muted-foreground text-xs md:max-w-48 md:truncate"
        label="URL"
        title={connector.url}
      >
        {connector.url}
      </ResponsiveCell>
      <ResponsiveCell label="Auth">
        <Badge variant="outline">{AUTH_LABEL[connector.authKind]}</Badge>
      </ResponsiveCell>
      <ResponsiveCell label="Status">
        <Badge variant={connector.status === "ok" ? "default" : "secondary"}>
          {STATUS_LABEL[connector.status]}
        </Badge>
      </ResponsiveCell>
      <ResponsiveCell label="Tools">
        <div className="flex flex-col gap-1">
          <span>{connector.tools.length}</span>
          {toolNames.length > 0 && (
            <span
              className="max-w-64 truncate text-muted-foreground text-xs"
              title={toolNames}
            >
              {toolNames}
            </span>
          )}
        </div>
      </ResponsiveCell>
      <ResponsiveCell label="Time limit">
        {connector.callTimeoutSeconds} s
      </ResponsiveCell>
      <ResponsiveCell className="text-muted-foreground" label="Your credential">
        {connector.authKind === "oauth" ? (
          <OAuthCredential connector={connector} />
        ) : (
          credentialLabel(connector)
        )}
      </ResponsiveCell>
      <ResponsiveActions className="text-right">
        <div className="flex justify-end gap-2">
          {connector.authKind === "header" ? (
            <Button onClick={paste} size="sm" variant="outline">
              Paste credential
            </Button>
          ) : null}
          {connector.authKind === "oauth" ? (
            <OAuthActions connector={connector} onSetClient={onSetClient} />
          ) : null}
          <Button onClick={editTimeout} size="sm" variant="outline">
            Time limit
          </Button>
          <Button onClick={remove} size="sm" variant="outline">
            Delete
          </Button>
        </div>
      </ResponsiveActions>
    </TableRow>
  );
}

function ConnectorsPage() {
  const connectors = Route.useLoaderData();
  const search = Route.useSearch();
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [pasting, setPasting] = useState<ConnectorRecord | null>(null);
  const [settingClient, setSettingClient] = useState<ConnectorRecord | null>(
    null
  );
  const [editingTimeout, setEditingTimeout] = useState<ConnectorRecord | null>(
    null
  );
  const [deleting, setDeleting] = useState<ConnectorRecord | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const connectNotice =
    search.connect_error ??
    (search.connected === undefined ? null : "Connected.");

  const openAdd = useCallback(() => setAdding(true), []);

  const closeAdd = useCallback(() => setAdding(false), []);

  const handleCreated = useCallback(
    async (connector: ConnectorRecord) => {
      setAdding(false);
      setNotice(addedMessage(connector));
      await router.invalidate();
    },
    [router]
  );

  const openPaste = useCallback(
    (connector: ConnectorRecord) => setPasting(connector),
    []
  );

  const closePaste = useCallback(() => setPasting(null), []);

  const handleSaved = useCallback(async () => {
    setPasting(null);
    await router.invalidate();
  }, [router]);

  const openSetClient = useCallback(
    (connector: ConnectorRecord) => setSettingClient(connector),
    []
  );

  const closeSetClient = useCallback(() => setSettingClient(null), []);

  const handleClientSaved = useCallback(async () => {
    setSettingClient(null);
    await router.invalidate();
  }, [router]);

  const openEditTimeout = useCallback(
    (connector: ConnectorRecord) => setEditingTimeout(connector),
    []
  );

  const closeEditTimeout = useCallback(() => setEditingTimeout(null), []);

  const handleTimeoutSaved = useCallback(async () => {
    setEditingTimeout(null);
    await router.invalidate();
  }, [router]);

  const openDelete = useCallback(
    (connector: ConnectorRecord) => setDeleting(connector),
    []
  );

  const closeDelete = useCallback(() => setDeleting(null), []);

  const handleDeleted = useCallback(
    async (name: string) => {
      setDeleting(null);
      setNotice(`Deleted ${name}.`);
      await router.invalidate();
    },
    [router]
  );

  return (
    <section className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-heading text-3xl text-foreground">Connectors</h1>
        <Button onClick={openAdd}>Add connector</Button>
      </div>
      {connectNotice !== null && (
        <p className="mb-4 text-muted-foreground text-sm">{connectNotice}</p>
      )}
      {notice !== null && (
        <p className="mb-4 text-muted-foreground text-sm">{notice}</p>
      )}
      {connectors.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No connectors yet. Add one by URL.
        </p>
      ) : (
        <ResponsiveTable>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>Auth</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tools</TableHead>
              <TableHead>Time limit</TableHead>
              <TableHead>Your credential</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connectors.map((connector) => (
              <ConnectorRow
                connector={connector}
                key={connector.id}
                onDelete={openDelete}
                onEditTimeout={openEditTimeout}
                onPaste={openPaste}
                onSetClient={openSetClient}
              />
            ))}
          </TableBody>
        </ResponsiveTable>
      )}
      <p className="mt-6 text-muted-foreground text-sm">
        Paste a credential as an agent from the agent&apos;s Connectors tab.
      </p>
      {adding ? (
        <AddConnectorDialog onClose={closeAdd} onCreated={handleCreated} />
      ) : null}
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
      {settingClient === null ? null : (
        <OAuthClientDialog
          connector={{ id: settingClient.id, name: settingClient.name }}
          onClose={closeSetClient}
          onSaved={handleClientSaved}
        />
      )}
      {editingTimeout === null ? null : (
        <CallTimeoutDialog
          connector={{
            id: editingTimeout.id,
            name: editingTimeout.name,
            callTimeoutSeconds: editingTimeout.callTimeoutSeconds,
          }}
          onClose={closeEditTimeout}
          onSaved={handleTimeoutSaved}
        />
      )}
      {deleting === null ? null : (
        <DeleteConnectorDialog
          connector={{ id: deleting.id, name: deleting.name }}
          onClose={closeDelete}
          onDeleted={handleDeleted}
        />
      )}
    </section>
  );
}
