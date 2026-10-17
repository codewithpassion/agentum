import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useState } from "react";
import {
  type CreatedTrigger,
  CreateTriggerDialog,
} from "#/components/triggers/create-trigger-dialog";
import { errorMessage } from "#/components/triggers/format";
import { TriggerSecretDialog } from "#/components/triggers/trigger-secret-dialog";
import { TriggerTable } from "#/components/triggers/trigger-table";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app/triggers")({
  loader: async () => {
    try {
      const [triggers, agents] = await Promise.all([
        getTrpc().triggers.list.query({}),
        getTrpc().agents.list.query({}),
      ]);
      return { agents, triggers };
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
  component: TriggersPage,
});

function TriggersPage() {
  const { agents, triggers } = Route.useLoaderData();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedTrigger | null>(null);
  const [secretTitle, setSecretTitle] = useState("Trigger created");
  const [error, setError] = useState<string | null>(null);

  const openCreate = useCallback(() => setCreating(true), []);

  const closeCreate = useCallback(() => setCreating(false), []);

  const showSecret = useCallback((next: CreatedTrigger) => {
    setCreating(false);
    setSecretTitle("Trigger created");
    setCreated(next);
  }, []);

  const closeSecret = useCallback(() => {
    setCreated(null);
    router.invalidate();
  }, [router]);

  const approveTrigger = useCallback(async (triggerId: string) => {
    setError(null);
    try {
      const approved = await getTrpc().triggers.approve.mutate({ triggerId });
      if (approved.secret === null) {
        setError("The approved trigger came back without a secret.");
        return;
      }
      setSecretTitle("Trigger approved");
      setCreated({ secret: approved.secret, trigger: approved.trigger });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  const rejectTrigger = useCallback(
    async (triggerId: string) => {
      setError(null);
      try {
        await getTrpc().triggers.reject.mutate({ triggerId });
        await router.invalidate();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [router]
  );

  const revokeTrigger = useCallback(
    async (triggerId: string) => {
      setError(null);
      try {
        await getTrpc().triggers.revoke.mutate({ triggerId });
        await router.invalidate();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [router]
  );

  const toggleTrigger = useCallback(
    async (triggerId: string, enabled: boolean) => {
      setError(null);
      try {
        await getTrpc().triggers.setEnabled.mutate({ enabled, triggerId });
        await router.invalidate();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [router]
  );

  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-heading text-3xl text-foreground">Triggers</h1>
        <Button onClick={openCreate}>Create trigger</Button>
      </div>
      {error !== null && (
        <p className="mb-4 text-destructive text-sm">{error}</p>
      )}
      {triggers.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No triggers yet. Create one to let an outside system start an agent
          run over HTTP.
        </p>
      ) : (
        <TriggerTable
          onApprove={approveTrigger}
          onReject={rejectTrigger}
          onRevoke={revokeTrigger}
          onToggle={toggleTrigger}
          showAgent
          triggers={triggers}
        />
      )}
      {creating ? (
        <CreateTriggerDialog
          agents={agents}
          onClose={closeCreate}
          onCreated={showSecret}
        />
      ) : null}
      {created === null ? null : (
        <TriggerSecretDialog
          onDone={closeSecret}
          secret={created.secret}
          title={secretTitle}
          triggerId={created.trigger.id}
        />
      )}
    </section>
  );
}
