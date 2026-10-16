import { formatDistanceToNow } from "date-fns";
import { useCallback } from "react";
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
import type { OAuthClientRecord } from "#/integrations/trpc/types";

export type ConnectedAppAccess = "read" | "write";

export interface ConnectedAppsTableProps {
  busyClientId: string | null;
  clients: OAuthClientRecord[];
  onRevoke: (clientId: string) => void;
  onSetAccess: (clientId: string, access: ConnectedAppAccess) => void;
}

const ACCESS_LABEL: Record<ConnectedAppAccess, string> = {
  read: "read-only",
  write: "full access",
};

const appName = (client: OAuthClientRecord): string =>
  client.name || "Unnamed app";

function StatusBadge({ status }: { status: OAuthClientRecord["status"] }) {
  if (status === "revoked") {
    return <Badge variant="destructive">Revoked</Badge>;
  }
  if (status === "approved") {
    return <Badge>Approved</Badge>;
  }
  return <Badge variant="secondary">Pending</Badge>;
}

function ClientButton({
  busy,
  clientId,
  label,
  name,
  onPress,
  variant = "outline",
}: {
  busy: boolean;
  clientId: string;
  label: string;
  name: string;
  onPress: (clientId: string) => void;
  variant?: "ghost" | "destructive" | "outline";
}) {
  const press = useCallback(() => onPress(clientId), [clientId, onPress]);
  return (
    <Button
      aria-label={`${label} for ${name}`}
      disabled={busy}
      onClick={press}
      size="xs"
      variant={variant}
    >
      {label}
    </Button>
  );
}

function RowActions({
  busy,
  client,
  onRevoke,
  onSetAccess,
}: {
  busy: boolean;
  client: OAuthClientRecord;
  onRevoke: ConnectedAppsTableProps["onRevoke"];
  onSetAccess: ConnectedAppsTableProps["onSetAccess"];
}) {
  const name = appName(client);
  const { clientId } = client;
  const approveRead = useCallback(
    (id: string) => onSetAccess(id, "read"),
    [onSetAccess]
  );
  const approveWrite = useCallback(
    (id: string) => onSetAccess(id, "write"),
    [onSetAccess]
  );

  const button = (label: string, onPress: (id: string) => void) => (
    <ClientButton
      busy={busy}
      clientId={clientId}
      key={label}
      label={label}
      name={name}
      onPress={onPress}
    />
  );

  if (client.status === "approved") {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {client.access === "write"
          ? button("Make read-only", approveRead)
          : button("Give full access", approveWrite)}
        <ClientButton
          busy={busy}
          clientId={clientId}
          label="Revoke"
          name={name}
          onPress={onRevoke}
          variant="destructive"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {button("Approve read-only", approveRead)}
      {button("Approve full access", approveWrite)}
      {client.status === "pending" ? (
        <ClientButton
          busy={busy}
          clientId={clientId}
          label="Deny"
          name={name}
          onPress={onRevoke}
          variant="ghost"
        />
      ) : null}
    </div>
  );
}

export function ConnectedAppsTable({
  busyClientId,
  clients,
  onRevoke,
  onSetAccess,
}: ConnectedAppsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Client ID</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Access</TableHead>
          <TableHead>Last used</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {clients.map((client) => (
          <TableRow key={client.clientId}>
            <TableCell className="font-medium">{appName(client)}</TableCell>
            <TableCell className="break-all font-mono text-muted-foreground text-xs">
              {client.clientId}
            </TableCell>
            <TableCell>
              <StatusBadge status={client.status} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              {client.access ? ACCESS_LABEL[client.access] : "None"}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {client.lastUsedAt
                ? formatDistanceToNow(new Date(client.lastUsedAt), {
                    addSuffix: true,
                  })
                : "never"}
            </TableCell>
            <TableCell className="text-right">
              <RowActions
                busy={busyClientId === client.clientId}
                client={client}
                onRevoke={onRevoke}
                onSetAccess={onSetAccess}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
