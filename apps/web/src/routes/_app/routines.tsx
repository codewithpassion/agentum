import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useState } from "react";
import { CreateRoutineDialog } from "#/components/routines/create-routine-dialog";
import { RoutineTable } from "#/components/routines/routine-table";
import { errorMessage } from "#/components/triggers/format";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app/routines")({
  loader: async () => {
    try {
      const [routines, agents] = await Promise.all([
        getTrpc().routines.list.query({}),
        getTrpc().agents.list.query({}),
      ]);
      return { agents, routines };
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
  component: RoutinesPage,
});

function RoutinesPage() {
  const { agents, routines } = Route.useLoaderData();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openCreate = useCallback(() => setCreating(true), []);

  const closeCreate = useCallback(() => setCreating(false), []);

  const handleCreated = useCallback(() => {
    setCreating(false);
    router.invalidate();
  }, [router]);

  const toggleRoutine = useCallback(
    async (routineId: string, enabled: boolean) => {
      setError(null);
      try {
        await getTrpc().routines.setEnabled.mutate({ enabled, routineId });
        await router.invalidate();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [router]
  );

  const removeRoutine = useCallback(
    async (routineId: string) => {
      setError(null);
      try {
        await getTrpc().routines.remove.mutate({ routineId });
        await router.invalidate();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [router]
  );

  return (
    <section className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-heading text-3xl text-foreground">Routines</h1>
        <Button onClick={openCreate}>Create routine</Button>
      </div>
      {error !== null && (
        <p className="mb-4 text-destructive text-sm">{error}</p>
      )}
      {routines.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No routines yet. Create one to start an agent on a schedule.
        </p>
      ) : (
        <RoutineTable
          onRemove={removeRoutine}
          onToggle={toggleRoutine}
          routines={routines}
          showAgent
        />
      )}
      {creating ? (
        <CreateRoutineDialog
          agents={agents}
          onClose={closeCreate}
          onCreated={handleCreated}
        />
      ) : null}
    </section>
  );
}
