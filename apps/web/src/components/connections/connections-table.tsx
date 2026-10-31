import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { useCallback } from "react";
import { ConfirmButton } from "#/components/confirm-action/confirm-button";
import {
  ResponsiveActions,
  ResponsiveCell,
  ResponsiveTable,
} from "#/components/responsive-table/responsive-table";
import { Badge } from "#/components/ui/badge";
import { buttonVariants } from "#/components/ui/button";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import type { RouterOutputs } from "#/integrations/trpc/types";
import {
  directionsOn,
  isEnded,
  isPending,
  kindWords,
  lastActivity,
  peerHost,
  peerName,
  sortConnections,
  statusWords,
} from "./connections-logic";

export type ConnectionRecord = RouterOutputs["a2a"]["list"][number];

function ConnectionRow({
  connection,
  onRevoke,
}: {
  connection: ConnectionRecord;
  onRevoke: (connectionId: string) => void;
}) {
  const revoke = useCallback(
    () => onRevoke(connection.id),
    [connection.id, onRevoke]
  );
  const peer = peerName(connection);
  const host = peerHost(connection);
  const activity = lastActivity(connection);
  const directions = directionsOn(connection);
  const pending = isPending(connection.status);
  const revokeDescription = `${peer} can no longer send ${connection.agentName} messages, and ${connection.agentName} can no longer message it. Messages waiting for approval are declined and runs it started are cancelled. The connection stays listed as revoked. To connect again you need a new invite.`;

  return (
    <TableRow>
      <ResponsiveCell className="font-medium" label="My agent">
        <Link params={{ agentId: connection.agentId }} to="/agents/$agentId">
          {connection.agentName}
        </Link>
      </ResponsiveCell>
      <ResponsiveCell label="Peer">
        <span className="flex flex-col">
          <span>{peer}</span>
          <span className="text-muted-foreground text-xs">
            {kindWords(connection.peerKind)}
            {host === null ? null : ` · ${host}`}
          </span>
        </span>
      </ResponsiveCell>
      <ResponsiveCell label="Directions">
        {directions.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {directions.map((direction) => (
              <Badge key={direction} variant="outline">
                {direction}
              </Badge>
            ))}
          </span>
        )}
      </ResponsiveCell>
      <ResponsiveCell label="Status">
        <span className="flex flex-col items-end gap-1">
          <Badge variant={pending ? "default" : "secondary"}>
            {statusWords(connection.status)}
          </Badge>
          {pending && connection.checkCode !== null ? (
            <span className="font-mono text-muted-foreground text-xs">
              {connection.checkCode}
            </span>
          ) : null}
          {pending ? (
            <span className="text-muted-foreground text-xs">
              Needs approval, open it to decide
            </span>
          ) : null}
        </span>
      </ResponsiveCell>
      <ResponsiveCell className="text-muted-foreground" label="Last activity">
        {activity === null
          ? "never"
          : formatDistanceToNow(new Date(activity), { addSuffix: true })}
      </ResponsiveCell>
      <ResponsiveActions className="text-right">
        <Link
          className={buttonVariants({ size: "sm", variant: "outline" })}
          params={{ connectionId: connection.id }}
          to="/settings/agent-connections/$connectionId"
        >
          Open
        </Link>
        {isEnded(connection.status) ? null : (
          <ConfirmButton
            description={revokeDescription}
            onConfirm={revoke}
            size="sm"
            title="Revoke this connection?"
            variant="outline"
          >
            Revoke
          </ConfirmButton>
        )}
      </ResponsiveActions>
    </TableRow>
  );
}

export function ConnectionsTable({
  connections,
  onRevoke,
}: {
  connections: readonly ConnectionRecord[];
  onRevoke: (connectionId: string) => void;
}) {
  return (
    <ResponsiveTable>
      <TableHeader>
        <TableRow>
          <TableHead>My agent</TableHead>
          <TableHead>Peer</TableHead>
          <TableHead>Directions</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Last activity</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortConnections(connections).map((connection) => (
          <ConnectionRow
            connection={connection}
            key={connection.id}
            onRevoke={onRevoke}
          />
        ))}
      </TableBody>
    </ResponsiveTable>
  );
}
