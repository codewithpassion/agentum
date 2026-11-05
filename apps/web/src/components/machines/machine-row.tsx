import { formatDistanceToNow } from "date-fns";
import { useCallback } from "react";
import {
  ResponsiveActions,
  ResponsiveCell,
} from "#/components/responsive-table/responsive-table";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { TableRow } from "#/components/ui/table";
import type { MachineRecord } from "#/integrations/trpc/types";
import { agentumInstallCommand, daemonInstallCommand } from "./enroll-commands";
import {
  canAddComputerRole,
  canRevoke,
  computerKind,
  daemonProduct,
  isDaemonOutdated,
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
  /** The version of the newest published daemon, or null when there is none. */
  latestDaemonVersion: string | null;
  latestRustVersion: string | null;
  machine: MachineRecord;
  onAddComputer: (machine: { id: string; name: string }) => void;
  onRevoke: (machine: { id: string; name: string }) => void;
  /** This deployment's origin, for the update command. Null while it is unknown. */
  origin: string | null;
}

export function MachineRow({
  latestDaemonVersion,
  latestRustVersion,
  machine,
  origin,
  onAddComputer,
  onRevoke,
}: MachineRowProps) {
  const { id, name } = machine;
  const rust = daemonProduct(machine) === "agentum-rs";
  const latestVersion = rust ? latestRustVersion : latestDaemonVersion;
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
      <ResponsiveCell label="Name">
        <div>
          <span className="font-medium">{machine.name}</span>
          {machine.singleUser ? (
            <p className="text-muted-foreground text-sm">shared user</p>
          ) : null}
          {machine.daemonVersion === null ? null : (
            <p className="text-muted-foreground text-sm">
              Daemon {machine.daemonVersion}
            </p>
          )}
          {isDaemonOutdated(machine, latestDaemonVersion, latestRustVersion) ? (
            <p className="text-sm">
              Daemon update available ({latestVersion}).
              {origin === null ? null : (
                <>
                  {" "}
                  Update by running{" "}
                  <code className="break-all rounded bg-muted px-1 font-mono text-xs">
                    {rust
                      ? agentumInstallCommand(origin)
                      : daemonInstallCommand(origin)}
                  </code>{" "}
                  on the machine.
                </>
              )}
            </p>
          ) : null}
        </div>
      </ResponsiveCell>
      <ResponsiveCell label="Roles">
        <div className="flex flex-col gap-1 max-md:items-end">
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
      </ResponsiveCell>
      <ResponsiveCell className="text-muted-foreground" label="Last seen">
        {lastSeen(machine)}
      </ResponsiveCell>
      <ResponsiveActions>
        <div className="flex items-center justify-end gap-2 max-md:flex-wrap max-md:justify-start">
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
      </ResponsiveActions>
    </TableRow>
  );
}
