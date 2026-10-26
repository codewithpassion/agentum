import type { MachineRole } from "@repo/db/shared";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useState } from "react";
import { EnrollDialog } from "#/components/machines/enroll-dialog";
import { MachineRow } from "#/components/machines/machine-row";
import { RevokeDialog } from "#/components/machines/revoke-dialog";
import { Button } from "#/components/ui/button";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app/settings/machines")({
  loader: async () => {
    try {
      return await getTrpc().machines.list.query();
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
  machine?: { id: string; name: string };
  role: MachineRole;
}

function MachinesPage() {
  const machines = Route.useLoaderData();
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(
    null
  );

  const openEnrol = useCallback(() => setDialog({ role: "agent_host" }), []);

  const openAddComputer = useCallback(
    () => setDialog({ role: "computer" }),
    []
  );

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
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-heading text-3xl text-foreground">Machines</h1>
        <div className="flex items-center gap-2">
          <Button onClick={openAddComputer} variant="outline">
            Add computer
          </Button>
          <Button onClick={openEnrol}>Enrol machine</Button>
        </div>
      </div>
      {machines.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No machines yet. Enrol one to run agents on it, or add a computer for
          an agent to use.
        </p>
      ) : (
        <Table>
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
                machine={machine}
                onAddComputer={addComputerTo}
                onRevoke={setRevoking}
              />
            ))}
          </TableBody>
        </Table>
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
