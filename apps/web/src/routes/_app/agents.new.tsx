import { createFileRoute, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback } from "react";
import { AgentForm, type AgentFormValues } from "#/components/agent/agent-form";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app/agents/new")({
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
  component: NewAgent,
});

function NewAgent() {
  const machines = Route.useLoaderData();
  const navigate = Route.useNavigate();

  const createAgent = useCallback(
    async (values: AgentFormValues) => {
      const agent = await getTrpc().agents.create.mutate({
        instructions: values.instructions,
        model: values.model,
        name: values.name,
        runtime: values.runtime,
        ...(values.runtime === "machine"
          ? { machineId: values.machineId }
          : {}),
      });
      await navigate({ to: "/agents/$agentId", params: { agentId: agent.id } });
    },
    [navigate]
  );

  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="mb-6 font-heading text-3xl text-foreground">New agent</h1>
      <AgentForm
        machines={machines}
        onSubmit={createAgent}
        submitLabel="Create agent"
      />
    </section>
  );
}
