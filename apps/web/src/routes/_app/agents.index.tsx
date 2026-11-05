import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { AgentsTable } from "#/components/agent/agents-table";
import { rowsOf } from "#/components/agent/agents-table-logic";
import { ArchivedAgents } from "#/components/agent/archived-agents";
import { buttonVariants } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app/agents/")({
  loader: async () => {
    try {
      const [agents, overview, members] = await Promise.all([
        getTrpc().agents.list.query({ includeArchived: true }),
        getTrpc().agents.overview.query(),
        getTrpc()
          .members.list.query()
          .catch(() => null),
      ]);
      return {
        archived: agents.filter((agent) => agent.status === "archived"),
        rows: rowsOf(
          agents.filter((agent) => agent.status !== "archived"),
          overview,
          members
        ),
      };
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
  component: AgentsIndex,
});

function AgentsIndex() {
  const { rows, archived } = Route.useLoaderData();

  return (
    <section className="mx-auto max-w-5xl">
      <header className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-heading text-3xl text-foreground">Agents</h1>
        <Link className={buttonVariants()} to="/agents/new">
          New agent
        </Link>
      </header>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No agents yet.</p>
      ) : (
        <AgentsTable rows={rows} />
      )}
      <ArchivedAgents agents={archived} />
    </section>
  );
}
