import { createFileRoute, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback } from "react";
import { runtimeConfigOf } from "#/components/agent/agent-config.ts";
import { AgentForm, type AgentFormValues } from "#/components/agent/agent-form";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app/agents/new")({
  loader: async () => {
    try {
      const [machines, providerKeys] = await Promise.all([
        getTrpc().machines.list.query(),
        getTrpc().agents.providerKeys.query(),
      ]);
      return { machines, providerKeys };
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
  const { machines, providerKeys } = Route.useLoaderData();
  const navigate = Route.useNavigate();

  const createAgent = useCallback(
    async (values: AgentFormValues) => {
      const runtimeConfig = runtimeConfigOf({}, values);
      const sendsConfig =
        (values.runtime === "cloud" || values.runtime === "machine") &&
        Object.keys(runtimeConfig).length > 0;
      const agent = await getTrpc().agents.create.mutate({
        instructions: values.instructions,
        model: values.model,
        name: values.name,
        runtime: values.runtime,
        ...(values.runtime === "machine"
          ? { machineId: values.machineId }
          : {}),
        ...(sendsConfig ? { runtimeConfig } : {}),
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
        providerKeys={providerKeys}
        submitLabel="Create agent"
      />
    </section>
  );
}
