import { formatDistanceToNow } from "date-fns";
import { useCallback, useMemo, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
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
import { duplicateNameClientIds } from "./duplicates.ts";

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
  onApprove,
  onRevoke,
  onSetAccess,
}: {
  busy: boolean;
  client: OAuthClientRecord;
  onApprove: (client: OAuthClientRecord, access: ConnectedAppAccess) => void;
  onRevoke: ConnectedAppsTableProps["onRevoke"];
  onSetAccess: ConnectedAppsTableProps["onSetAccess"];
}) {
  const name = appName(client);
  const { clientId } = client;
  const downgrade = useCallback(
    (id: string) => onSetAccess(id, "read"),
    [onSetAccess]
  );
  // Granting access asks first: the name is chosen by whoever registered the app.
  const approveRead = useCallback(
    () => onApprove(client, "read"),
    [client, onApprove]
  );
  const approveWrite = useCallback(
    () => onApprove(client, "write"),
    [client, onApprove]
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
          ? button("Make read-only", downgrade)
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

function ApproveDialog({
  duplicate,
  onCancel,
  onConfirm,
  target,
}: {
  duplicate: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  target: { access: ConnectedAppAccess; client: OAuthClientRecord } | null;
}) {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onCancel();
      }
    },
    [onCancel]
  );
  return (
    <AlertDialog onOpenChange={handleOpenChange} open={target !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Approve {target ? appName(target.client) : ""}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target
              ? `This gives the app with client ID ${target.client.clientId} ${ACCESS_LABEL[target.access]} to this workspace through MCP. Anyone can register an app under any name, so check the client ID matches the one the app was refused with.`
              : null}
            {duplicate
              ? " Another app has the same name. Be sure this is the one you connected."
              : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Approve</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ConnectedAppsTable({
  busyClientId,
  clients,
  onRevoke,
  onSetAccess,
}: ConnectedAppsTableProps) {
  const duplicates = useMemo(() => duplicateNameClientIds(clients), [clients]);
  const [target, setTarget] = useState<{
    access: ConnectedAppAccess;
    client: OAuthClientRecord;
  } | null>(null);
  const requestApproval = useCallback(
    (client: OAuthClientRecord, access: ConnectedAppAccess) =>
      setTarget({ access, client }),
    []
  );
  const cancelApproval = useCallback(() => setTarget(null), []);
  const confirmApproval = useCallback(() => {
    if (target) {
      onSetAccess(target.client.clientId, target.access);
    }
    setTarget(null);
  }, [onSetAccess, target]);

  return (
    <>
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
              <TableCell className="font-medium">
                {appName(client)}
                {duplicates.has(client.clientId) ? (
                  <p className="font-normal text-destructive text-xs">
                    Same name as another app
                  </p>
                ) : null}
              </TableCell>
              <TableCell className="break-all font-mono text-muted-foreground text-xs">
                {client.clientId}
                <p className="font-sans">
                  First seen{" "}
                  {formatDistanceToNow(new Date(client.firstSeenAt), {
                    addSuffix: true,
                  })}
                </p>
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
                  onApprove={requestApproval}
                  onRevoke={onRevoke}
                  onSetAccess={onSetAccess}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ApproveDialog
        duplicate={target ? duplicates.has(target.client.clientId) : false}
        onCancel={cancelApproval}
        onConfirm={confirmApproval}
        target={target}
      />
    </>
  );
}
