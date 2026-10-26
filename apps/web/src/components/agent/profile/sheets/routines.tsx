import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { CreateRoutineDialog } from "#/components/routines/create-routine-dialog";
import { RoutineTable } from "#/components/routines/routine-table";
import { errorMessage } from "#/components/triggers/format";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";
import type { RoutineRecord } from "#/integrations/trpc/types";
import type { AgentPanelProps } from "./props.ts";

export function RoutinesPanel({ agent }: AgentPanelProps) {
  const agentId = agent.id;
  const router = useRouter();
  const [routines, setRoutines] = useState<RoutineRecord[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);

  const fetchRoutines = useCallback(
    () => getTrpc().routines.list.query({ agentId }),
    [agentId]
  );

  useEffect(() => {
    let active = true;
    fetchRoutines()
      .then((items) => {
        if (active) {
          setRoutines(items);
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(errorMessage(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [fetchRoutines]);

  // The profile rows read the routines too, so refresh the page data as well.
  const reload = useCallback(async () => {
    try {
      setRoutines(await fetchRoutines());
      setError(undefined);
      await router.invalidate();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [fetchRoutines, router]);

  const change = useCallback(
    async (run: () => Promise<unknown>) => {
      setError(undefined);
      try {
        await run();
      } catch (cause) {
        setError(errorMessage(cause));
        return;
      }
      await reload();
    },
    [reload]
  );

  const toggle = useCallback(
    (routineId: string, enabled: boolean) =>
      change(() =>
        getTrpc().routines.setEnabled.mutate({ enabled, routineId })
      ),
    [change]
  );
  const remove = useCallback(
    (routineId: string) =>
      change(() => getTrpc().routines.remove.mutate({ routineId })),
    [change]
  );
  const approve = useCallback(
    (routineId: string) =>
      change(() => getTrpc().routines.approve.mutate({ routineId })),
    [change]
  );
  const reject = useCallback(
    (routineId: string) =>
      change(() => getTrpc().routines.reject.mutate({ routineId })),
    [change]
  );
  const openCreate = useCallback(() => setCreating(true), []);
  const closeCreate = useCallback(() => setCreating(false), []);
  const created = useCallback(() => {
    setCreating(false);
    reload();
  }, [reload]);

  let body: ReactNode = (
    <p className="text-muted-foreground text-sm">Loading routines.</p>
  );
  if (routines !== undefined) {
    body =
      routines.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No routines for this agent yet.
        </p>
      ) : (
        <RoutineTable
          onApprove={approve}
          onReject={reject}
          onRemove={remove}
          onToggle={toggle}
          routines={routines}
          showAgent={false}
        />
      );
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        <Button onClick={openCreate}>Create routine</Button>
      </div>
      {error === undefined ? null : (
        <p className="text-destructive text-sm">{error}</p>
      )}
      {body}
      {creating ? (
        <CreateRoutineDialog
          agentId={agentId}
          onClose={closeCreate}
          onCreated={created}
        />
      ) : null}
    </section>
  );
}
