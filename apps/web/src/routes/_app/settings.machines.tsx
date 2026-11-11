import type { MachineEnrollRole } from "@repo/db/shared";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_ENROLL_ROLE,
  EnrollDialog,
} from "#/components/machines/enroll-dialog";
import {
  ENROLL_BUTTON_LABEL,
  visibleMachines,
} from "#/components/machines/machine-logic";
import { MachineRow } from "#/components/machines/machine-row";
import { RevokeDialog } from "#/components/machines/revoke-dialog";
import { ResponsiveTable } from "#/components/responsive-table/responsive-table";
import { Button } from "#/components/ui/button";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

export const Route = createFileRoute("/_app/settings/machines")({
  loader: async () =>
    loadOrLogin(async () => {
      const trpc = getTrpc();
      const [machines, latestVersion] = await Promise.all([
        trpc.machines.list.query(),
        trpc.machines.newestDaemonVersion.query(),
      ]);
      return { latestVersion, machines };
    }),
  component: MachinesPage,
});

interface DialogState {
  machine?: { id: string; name: string };
  role: MachineEnrollRole;
}

function MachinesPage() {
  const { latestVersion, machines } = Route.useLoaderData();
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(
    null
  );
  const [origin, setOrigin] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const [showRevoked, setShowRevoked] = useState(false);
  const toggleRevoked = useCallback(() => setShowRevoked((on) => !on), []);

  const openEnrol = useCallback(
    () => setDialog({ role: DEFAULT_ENROLL_ROLE }),
    []
  );

  const knownMachineIds = useMemo(
    () => machines.map((machine) => machine.id),
    [machines]
  );
  const shown = visibleMachines(machines, showRevoked);
  const revokedCount =
    machines.length - visibleMachines(machines, false).length;

  const addComputerTo = useCallback(
    (machine: { id: string; name: string }) =>
      setDialog({ role: "computer", machine }),
    []
  );

  const closeDialog = useCallback(() => {
    setDialog(null);
    router.invalidate();
  }, [router]);

  const closeRevoke = useCallback(() => setRevoking(null), []);

  const revoked = useCallback(() => {
    setRevoking(null);
    router.invalidate();
  }, [router]);

  return (
    <section className="mx-auto max-w-4xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-heading text-3xl text-foreground [overflow-wrap:normal]">
          Machines
        </h1>
        <div className="flex items-center gap-2">
          {revokedCount > 0 ? (
            <Button
              aria-pressed={showRevoked}
              onClick={toggleRevoked}
              variant="outline"
            >
              {showRevoked ? "Hide" : "Show"} revoked ({revokedCount})
            </Button>
          ) : null}
          {machines.length > 0 ? (
            <Button onClick={openEnrol}>{ENROLL_BUTTON_LABEL}</Button>
          ) : null}
        </div>
      </div>
      {machines.length === 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-sm">
            No machines yet. Enrol one to run agents on it, give agents a
            computer, or both.
          </p>
          <div>
            <Button onClick={openEnrol}>{ENROLL_BUTTON_LABEL}</Button>
          </div>
        </div>
      ) : (
        <ResponsiveTable>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Roles</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((machine) => (
              <MachineRow
                key={machine.id}
                latestVersion={latestVersion}
                machine={machine}
                onAddComputer={addComputerTo}
                onRevoke={setRevoking}
                origin={origin}
              />
            ))}
          </TableBody>
        </ResponsiveTable>
      )}
      {dialog ? (
        <EnrollDialog
          knownMachineIds={knownMachineIds}
          machine={dialog.machine}
          onClose={closeDialog}
          role={dialog.role}
        />
      ) : null}
      {revoking ? (
        <RevokeDialog
          machine={revoking}
          onClose={closeRevoke}
          onRevoked={revoked}
        />
      ) : null}
    </section>
  );
}
