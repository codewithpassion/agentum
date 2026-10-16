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
import type { TriggerRecord } from "#/integrations/trpc/types";
import { lastFiredLabel } from "./format.ts";

function TriggerRow({
  onRevoke,
  showAgent,
  trigger,
}: {
  onRevoke: (triggerId: string) => void;
  showAgent: boolean;
  trigger: TriggerRecord;
}) {
  const revoke = useCallback(
    () => onRevoke(trigger.id),
    [onRevoke, trigger.id]
  );
  const active = trigger.revokedAt === null;

  return (
    <TableRow>
      <TableCell className="font-medium">{trigger.name}</TableCell>
      {showAgent ? <TableCell>{trigger.agentName}</TableCell> : null}
      <TableCell className="font-mono text-muted-foreground text-xs">
        {trigger.tokenPrefix}…
      </TableCell>
      <TableCell className="text-muted-foreground">
        {lastFiredLabel(trigger.lastFiredAt)}
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

export function TriggerTable({
  onRevoke,
  showAgent,
  triggers,
}: {
  onRevoke: (triggerId: string) => void;
  showAgent: boolean;
  triggers: readonly TriggerRecord[];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          {showAgent ? <TableHead>Agent</TableHead> : null}
          <TableHead>Token</TableHead>
          <TableHead>Last fired</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {triggers.map((trigger) => (
          <TriggerRow
            key={trigger.id}
            onRevoke={onRevoke}
            showAgent={showAgent}
            trigger={trigger}
          />
        ))}
      </TableBody>
    </Table>
  );
}
