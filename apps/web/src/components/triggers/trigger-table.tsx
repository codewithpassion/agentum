import { isPendingProposal } from "@repo/db/shared";
import { type ReactNode, useCallback } from "react";
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
import type { TriggerRecord } from "#/integrations/trpc/types";
import { lastFiredLabel } from "./format.ts";

/** A proposal nobody has approved and nobody has removed. */
const isAwaitingApproval = (trigger: TriggerRecord): boolean =>
  trigger.revokedAt === null && isPendingProposal(trigger);

function statusLabel(trigger: TriggerRecord): string {
  if (trigger.revokedAt !== null) {
    return "revoked";
  }
  if (isPendingProposal(trigger)) {
    return "awaiting approval";
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
  onToggle,
  showAgent,
  trigger,
}: {
  onApprove: (triggerId: string) => void;
  onReject: (triggerId: string) => void;
  onRevoke: (triggerId: string) => void;
  onToggle: (triggerId: string, enabled: boolean) => void;
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
  const paused = trigger.disabledAt !== null;
  const toggle = useCallback(
    () => onToggle(trigger.id, paused),
    [onToggle, trigger.id, paused]
  );
  const pending = isAwaitingApproval(trigger);
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
      <>
        <Button onClick={toggle} size="sm" variant="outline">
          {paused ? "Resume" : "Pause"}
        </Button>{" "}
        <ConfirmButton
          description={`Revoke "${trigger.name}"? Its URL token stops working and cannot be restored.`}
          onConfirm={revoke}
          size="sm"
          title="Revoke trigger?"
          variant="outline"
        >
          Revoke
        </ConfirmButton>
      </>
    );
  }

  return (
    <TableRow>
      <ResponsiveCell className="font-medium" label="Name">
        <div>
          <div>{trigger.name}</div>
          {pending ? (
            <div className="font-normal text-muted-foreground text-xs">
              Proposed by {trigger.agentName}
            </div>
          ) : null}
        </div>
      </ResponsiveCell>
      {showAgent ? (
        <ResponsiveCell label="Agent">{trigger.agentName}</ResponsiveCell>
      ) : null}
      <ResponsiveCell
        className="font-mono text-muted-foreground text-xs"
        label="Token"
      >
        {pending ? "none yet" : `${trigger.tokenPrefix}…`}
      </ResponsiveCell>
      <ResponsiveCell className="text-muted-foreground" label="Last fired">
        {lastFiredLabel(trigger.lastFiredAt)}
      </ResponsiveCell>
      <ResponsiveCell label="Status">
        <Badge variant={label === "active" ? "default" : "secondary"}>
          {label}
        </Badge>
      </ResponsiveCell>
      <ResponsiveActions className="text-right">{actions}</ResponsiveActions>
    </TableRow>
  );
}

export function TriggerTable({
  onApprove,
  onReject,
  onRevoke,
  onToggle,
  showAgent,
  triggers,
}: {
  onApprove: (triggerId: string) => void;
  onReject: (triggerId: string) => void;
  onRevoke: (triggerId: string) => void;
  onToggle: (triggerId: string, enabled: boolean) => void;
  showAgent: boolean;
  triggers: readonly TriggerRecord[];
}) {
  return (
    <ResponsiveTable>
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
            onToggle={onToggle}
            showAgent={showAgent}
            trigger={trigger}
          />
        ))}
      </TableBody>
    </ResponsiveTable>
  );
}
