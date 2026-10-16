import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { buttonVariants } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app/agents/")({
  loader: async () => {
    try {
      return await getTrpc().agents.list.query({});
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
  const agents = Route.useLoaderData();

  return (
    <section className="mx-auto max-w-3xl">
      <header className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-heading text-3xl text-foreground">Agents</h1>
        <Link className={buttonVariants()} to="/agents/new">
          New agent
        </Link>
      </header>
      {agents.length === 0 ? (
        <p className="text-muted-foreground text-sm">No agents yet.</p>
      ) : (
        <ul className="divide-y divide-border border-border border-y">
          {agents.map((agent) => (
            <li key={agent.id}>
              <Link
                className="flex items-center justify-between gap-4 py-3 text-foreground no-underline hover:text-primary"
                params={{ agentId: agent.id }}
                to="/agents/$agentId"
              >
                <span className="font-medium">{agent.name}</span>
                <span className="text-muted-foreground text-sm">
                  <code>{agent.slug}</code> · {agent.runtime} · {agent.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
