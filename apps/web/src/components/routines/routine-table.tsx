import { isPendingProposal, ROUTINE_ERROR_LIMIT } from "@repo/db/shared";
import { formatDistanceToNow } from "date-fns";
import { useCallback } from "react";
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
import type { RoutineRecord } from "#/integrations/trpc/types";
import { lastFiredLabel } from "../triggers/format.ts";
import { describeCron } from "./describe-cron.ts";

function nextRunLabel(routine: RoutineRecord): string {
  if (isPendingProposal(routine)) {
    return "awaiting approval";
  }
  if (routine.disabledAt !== null) {
    return "paused";
  }
  return routine.nextRunAt === null
    ? "never"
    : formatDistanceToNow(new Date(routine.nextRunAt), { addSuffix: true });
}

function statusLabel(routine: RoutineRecord): string {
  if (isPendingProposal(routine)) {
    return "awaiting approval";
  }
  if (routine.disabledAt === null) {
    return "active";
  }
  return routine.consecutiveErrors >= ROUTINE_ERROR_LIMIT
    ? "off after errors"
    : "paused";
}

function RoutineRow({
  onApprove,
  onReject,
  onRemove,
  onToggle,
  routine,
  showAgent,
}: {
  onApprove: (routineId: string) => void;
  onReject: (routineId: string) => void;
  onRemove: (routineId: string) => void;
  onToggle: (routineId: string, enabled: boolean) => void;
  routine: RoutineRecord;
  showAgent: boolean;
}) {
  const remove = useCallback(
    () => onRemove(routine.id),
    [onRemove, routine.id]
  );
  const approve = useCallback(
    () => onApprove(routine.id),
    [onApprove, routine.id]
  );
  const reject = useCallback(
    () => onReject(routine.id),
    [onReject, routine.id]
  );
  const active = routine.disabledAt === null;
  const pending = isPendingProposal(routine);
  const toggle = useCallback(
    () => onToggle(routine.id, !active),
    [onToggle, routine.id, active]
  );

  return (
    <TableRow>
      <ResponsiveCell className="font-medium" label="Name">
        {routine.name}
        {pending ? (
          <div className="font-normal text-muted-foreground text-xs">
            Proposed by {routine.agentName}
          </div>
        ) : null}
      </ResponsiveCell>
      {showAgent ? (
        <ResponsiveCell label="Agent">{routine.agentName}</ResponsiveCell>
      ) : null}
      <ResponsiveCell label="Schedule">
        <div>
          <div title={routine.cron}>
            {describeCron(routine.cron, routine.timezone)}
          </div>
          <div className="font-mono text-muted-foreground text-xs">
            {routine.cron} {routine.timezone}
          </div>
        </div>
      </ResponsiveCell>
      <ResponsiveCell className="text-muted-foreground" label="Next run">
        {nextRunLabel(routine)}
      </ResponsiveCell>
      <ResponsiveCell className="text-muted-foreground" label="Last fired">
        {lastFiredLabel(routine.lastFiredAt)}
      </ResponsiveCell>
      <ResponsiveCell label="Status">
        <Badge
          title={routine.lastError ?? undefined}
          variant={active && !pending ? "default" : "secondary"}
        >
          {statusLabel(routine)}
        </Badge>
      </ResponsiveCell>
      <ResponsiveActions className="text-right">
        <div className="flex justify-end gap-2">
          {pending ? (
            <>
              <Button onClick={approve} size="sm">
                Approve
              </Button>
              <Button onClick={reject} size="sm" variant="outline">
                Reject
              </Button>
            </>
          ) : (
            <>
              <Button onClick={toggle} size="sm" variant="outline">
                {active ? "Pause" : "Resume"}
              </Button>
              <ConfirmButton
                description={`Remove "${routine.name}"? It stops running and cannot be restored.`}
                onConfirm={remove}
                size="sm"
                title="Remove routine?"
                variant="outline"
              >
                Remove
              </ConfirmButton>
            </>
          )}
        </div>
      </ResponsiveActions>
    </TableRow>
  );
}

export function RoutineTable({
  onApprove,
  onReject,
  onRemove,
  onToggle,
  routines,
  showAgent,
}: {
  onApprove: (routineId: string) => void;
  onReject: (routineId: string) => void;
  onRemove: (routineId: string) => void;
  onToggle: (routineId: string, enabled: boolean) => void;
  routines: readonly RoutineRecord[];
  showAgent: boolean;
}) {
  return (
    <ResponsiveTable>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          {showAgent ? <TableHead>Agent</TableHead> : null}
          <TableHead>Schedule</TableHead>
          <TableHead>Next run</TableHead>
          <TableHead>Last fired</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {routines.map((routine) => (
          <RoutineRow
            key={routine.id}
            onApprove={onApprove}
            onReject={onReject}
            onRemove={onRemove}
            onToggle={onToggle}
            routine={routine}
            showAgent={showAgent}
          />
        ))}
      </TableBody>
    </ResponsiveTable>
  );
}
