import { isPendingProposal } from "@repo/db/shared";
import { type ReactNode, useCallback } from "react";
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

function statusLabel(trigger: TriggerRecord): string {
  if (isPendingProposal(trigger)) {
    return "awaiting approval";
  }
  if (trigger.revokedAt !== null) {
    return "revoked";
  }
  if (trigger.disabledAt !== null) {
    return "paused";
  }
  return "active";
}

function TriggerRow({
  onApprove,
  onReject,
  onRevoke,
  showAgent,
  trigger,
}: {
  onApprove: (triggerId: string) => void;
  onReject: (triggerId: string) => void;
  onRevoke: (triggerId: string) => void;
  showAgent: boolean;
  trigger: TriggerRecord;
}) {
  const approve = useCallback(
    () => onApprove(trigger.id),
    [onApprove, trigger.id]
  );
  const reject = useCallback(
    () => onReject(trigger.id),
    [onReject, trigger.id]
  );
  const revoke = useCallback(
    () => onRevoke(trigger.id),
    [onRevoke, trigger.id]
  );
  const pending = isPendingProposal(trigger);
  const label = statusLabel(trigger);

  let actions: ReactNode = null;
  if (pending) {
    actions = (
      <>
        <Button onClick={approve} size="sm">
          Approve
        </Button>{" "}
        <Button onClick={reject} size="sm" variant="outline">
          Reject
        </Button>
      </>
    );
  } else if (trigger.revokedAt === null) {
    actions = (
      <Button onClick={revoke} size="sm" variant="outline">
        Revoke
      </Button>
    );
  }

  return (
    <TableRow>
      <TableCell className="font-medium">
        <div>{trigger.name}</div>
        {pending ? (
          <div className="font-normal text-muted-foreground text-xs">
            Proposed by {trigger.agentName}
          </div>
        ) : null}
      </TableCell>
      {showAgent ? <TableCell>{trigger.agentName}</TableCell> : null}
      <TableCell className="font-mono text-muted-foreground text-xs">
        {pending ? "none yet" : `${trigger.tokenPrefix}…`}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {lastFiredLabel(trigger.lastFiredAt)}
      </TableCell>
      <TableCell>
        <Badge variant={label === "active" ? "default" : "secondary"}>
          {label}
        </Badge>
      </TableCell>
      <TableCell className="text-right">{actions}</TableCell>
    </TableRow>
  );
}

export function TriggerTable({
  onApprove,
  onReject,
  onRevoke,
  showAgent,
  triggers,
}: {
  onApprove: (triggerId: string) => void;
  onReject: (triggerId: string) => void;
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
            onApprove={onApprove}
            onReject={onReject}
            onRevoke={onRevoke}
            showAgent={showAgent}
            trigger={trigger}
          />
        ))}
      </TableBody>
    </Table>
  );
}
