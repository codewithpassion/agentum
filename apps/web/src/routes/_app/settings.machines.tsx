import type { MachineRole } from "@repo/db/shared";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useState } from "react";
import { CommandBlock } from "#/components/machines/command-block";
import { agentumInstallCommand } from "#/components/machines/enroll-commands";
import { EnrollDialog } from "#/components/machines/enroll-dialog";
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

export const Route = createFileRoute("/_app/settings/machines")({
  loader: async () => {
    try {
      const trpc = getTrpc();
      const [machines, latestDaemonVersion, latestRustVersion] =
        await Promise.all([
          trpc.machines.list.query(),
          trpc.machines.newestDaemonVersion.query(),
          trpc.machines.newestDaemonVersion.query("agentum-rs"),
        ]);
      return { latestDaemonVersion, latestRustVersion, machines };
    } catch (error) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        throw redirect({ to: "/login" });
      }
      throw error;
    }
  },
  component: MachinesPage,
});

interface DialogState {
  machine?: { id: string; name: string; rust?: boolean };
  role: MachineRole;
}

function MachinesPage() {
  const { latestDaemonVersion, latestRustVersion, machines } =
    Route.useLoaderData();
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(
    null
  );
  const [origin, setOrigin] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const openEnrol = useCallback(() => setDialog({ role: "agent_host" }), []);

  const openAddComputer = useCallback(
    () => setDialog({ role: "computer" }),
    []
  );

  const addComputerTo = useCallback(
    (machine: { id: string; name: string; rust?: boolean }) =>
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
          <Button onClick={openAddComputer} variant="outline">
            Add computer
          </Button>
          <Button onClick={openEnrol}>Enrol machine</Button>
        </div>
      </div>
      {machines.length === 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-sm">
            No machines yet. Enrol one to run agents on it, or add a computer
            for an agent to use.
          </p>
          {origin !== null && (
            <CommandBlock
              command={agentumInstallCommand(origin)}
              heading="Install Agentum on a Linux machine"
            />
          )}
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
            {machines.map((machine) => (
              <MachineRow
                key={machine.id}
                latestDaemonVersion={latestDaemonVersion}
                latestRustVersion={latestRustVersion}
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
