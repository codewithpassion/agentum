import { formatDistanceToNow } from "date-fns";
import { useCallback } from "react";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { TableCell, TableRow } from "#/components/ui/table";
import type { MachineRecord } from "#/integrations/trpc/types";
import {
  canAddComputerRole,
  canRevoke,
  computerKind,
  type RoleTone,
  roleRows,
} from "./machine-logic";

const TONE_VARIANT: Record<RoleTone, "default" | "secondary" | "destructive"> =
  {
    bad: "destructive",
    good: "default",
    muted: "secondary",
  };

/** The later of the agent host's and the computer's last contact, or "never". */
function lastSeen(machine: MachineRecord): string {
  const stamps = [machine.lastSeenAt, machine.computerLastSeenAt].filter(
    (stamp): stamp is string => stamp !== null
  );
  if (stamps.length === 0) {
    return "never";
  }
  const latest = stamps.reduce((a, b) =>
    Date.parse(a) >= Date.parse(b) ? a : b
  );
  return formatDistanceToNow(new Date(latest), { addSuffix: true });
}

interface MachineRowProps {
  machine: MachineRecord;
  onAddComputer: (machine: { id: string; name: string }) => void;
  onRevoke: (machine: { id: string; name: string }) => void;
}

export function MachineRow({
  machine,
  onAddComputer,
  onRevoke,
}: MachineRowProps) {
  const { id, name } = machine;
  const handleAddComputer = useCallback(
    () => onAddComputer({ id, name }),
    [onAddComputer, id, name]
  );
  const handleRevoke = useCallback(
    () => onRevoke({ id, name }),
    [onRevoke, id, name]
  );

  return (
    <TableRow>
      <TableCell>
        <span className="font-medium">{machine.name}</span>
        {machine.singleUser ? (
          <p className="text-muted-foreground text-sm">shared user</p>
        ) : null}
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-1">
          {roleRows(machine).map((row) => (
            <div className="flex flex-wrap items-center gap-2" key={row.role}>
              <span>{row.label}</span>
              <Badge variant={TONE_VARIANT[row.tone]}>{row.status}</Badge>
              {row.role === "computer" ? (
                <span className="text-muted-foreground text-xs">
                  {computerKind(machine) ?? "Not connected yet"}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {lastSeen(machine)}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-2">
          {canAddComputerRole(machine) ? (
            <Button onClick={handleAddComputer} size="sm" variant="outline">
              Add computer role
            </Button>
          ) : null}
          {canRevoke(machine) ? (
            <Button onClick={handleRevoke} size="sm" variant="destructive">
              Revoke
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
