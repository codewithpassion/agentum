import type { MachineStatus } from "@repo/db/shared";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { formatDistanceToNow } from "date-fns";
import { useCallback, useState } from "react";
import { EnrollDialog } from "#/components/machines/enroll-dialog";
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
import { getTrpc } from "#/integrations/trpc/client";
import type { MachineRecord } from "#/integrations/trpc/types";

export const Route = createFileRoute("/_app/machines")({
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

const STATUS_VARIANT: Record<
  MachineStatus,
  "default" | "secondary" | "destructive"
> = {
  online: "default",
  offline: "secondary",
  revoked: "destructive",
};

function lastSeen(machine: MachineRecord): string {
  return machine.lastSeenAt
    ? formatDistanceToNow(new Date(machine.lastSeenAt), { addSuffix: true })
    : "never";
}

function MachinesPage() {
  const machines = Route.useLoaderData();
  const router = useRouter();
  const [enrolling, setEnrolling] = useState(false);

  const openEnroll = useCallback(() => setEnrolling(true), []);

  const closeEnroll = useCallback(() => {
    setEnrolling(false);
    router.invalidate();
  }, [router]);

  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-heading text-3xl text-foreground">Machines</h1>
        <Button onClick={openEnroll}>Enrol machine</Button>
      </div>
      {machines.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No machines yet. Enrol one to run agents on it.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {machines.map((machine) => (
              <TableRow key={machine.id}>
                <TableCell>
                  <span className="font-medium">{machine.name}</span>
                  {machine.singleUser ? (
                    <p className="text-muted-foreground text-sm">shared user</p>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[machine.status]}>
                    {machine.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {lastSeen(machine)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {enrolling ? <EnrollDialog onClose={closeEnroll} /> : null}
    </section>
  );
}
