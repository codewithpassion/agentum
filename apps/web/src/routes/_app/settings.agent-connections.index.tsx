import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { type AddChoice, AddMenu } from "#/components/connections/add-menu";
import { WHAT_A_CONNECTION_IS } from "#/components/connections/connections-logic";
import { ConnectionsTable } from "#/components/connections/connections-table";
import { InviteDialog } from "#/components/connections/invite-dialog";
import { JoinDialog } from "#/components/connections/join-dialog";
import { OutsideAgentDialog } from "#/components/connections/outside-agent-dialog";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";
import { errorMessage } from "#/lib/error-message";

const searchSchema = z.object({
  join: z.string().min(1).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/settings/agent-connections/")({
  validateSearch: (search) => searchSchema.parse(search),
  loader: async () =>
    loadOrLogin(async () => {
      const trpc = getTrpc();
      const [connections, agents] = await Promise.all([
        trpc.a2a.list.query({}),
        trpc.agents.list.query({}),
      ]);
      return { agents, connections };
    }),
  component: AgentConnectionsPage,
});

function AgentConnectionsPage() {
  const { agents, connections } = Route.useLoaderData();
  const { join } = Route.useSearch();
  const router = useRouter();
  const [dialog, setDialog] = useState<AddChoice | null>(
    join === undefined ? null : "join"
  );
  const [error, setError] = useState<string | null>(null);

  const pickable = useMemo(
    () =>
      agents
        .filter((agent) => agent.status !== "archived")
        .map((agent) => ({ id: agent.id, name: agent.name })),
    [agents]
  );

  const chooseAdd = useCallback((choice: AddChoice) => setDialog(choice), []);

  const navigate = Route.useNavigate();
  const closeDialog = useCallback(() => {
    setDialog(null);
    if (join !== undefined) {
      navigate({ replace: true, search: {} });
    }
  }, [join, navigate]);

  const reload = useCallback(() => {
    router.invalidate();
  }, [router]);

  const revokeConnection = useCallback(
    async (connectionId: string) => {
      setError(null);
      try {
        await getTrpc().a2a.revoke.mutate({ connectionId });
        await router.invalidate();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [router]
  );

  return (
    <section className="mx-auto max-w-4xl">
      <div className="mb-2 flex items-center justify-between gap-4">
        <h1 className="font-heading text-3xl text-foreground">
          Agent connections
        </h1>
        <AddMenu onChoose={chooseAdd} />
      </div>
      <p className="mb-6 text-muted-foreground text-sm">
        {WHAT_A_CONNECTION_IS}
      </p>
      {error !== null && (
        <p className="mb-4 text-destructive text-sm">{error}</p>
      )}
      {connections.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No connections yet. Use Add connection to make the first one.
        </p>
      ) : (
        <ConnectionsTable
          connections={connections}
          onRevoke={revokeConnection}
        />
      )}
      {dialog === "invite" ? (
        <InviteDialog
          agents={pickable}
          onChanged={reload}
          onClose={closeDialog}
        />
      ) : null}
      {dialog === "join" ? (
        <JoinDialog
          agents={pickable}
          initialLink={join}
          onChanged={reload}
          onClose={closeDialog}
        />
      ) : null}
      {dialog === "outside" ? (
        <OutsideAgentDialog
          agents={pickable}
          onChanged={reload}
          onClose={closeDialog}
        />
      ) : null}
    </section>
  );
}
