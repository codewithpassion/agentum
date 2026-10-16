import { createFileRoute, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback } from "react";
import { z } from "zod";
import { agentTabs } from "#/components/agent/agent-tabs";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { getTrpc } from "#/integrations/trpc/client";

const tabIds = agentTabs.map((tab) => tab.id);
const defaultTab = tabIds[0] ?? "";

const searchSchema = z.object({
  tab: z
    .string()
    .refine((id) => tabIds.includes(id))
    .optional()
    .catch(undefined),
  session: z.string().min(1).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/agents/$agentId")({
  validateSearch: (search) => searchSchema.parse(search),
  loader: async ({ params }) => {
    try {
      return await getTrpc().agents.get.query({ id: params.agentId });
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
  component: AgentPage,
});

function AgentPage() {
  const agent = Route.useLoaderData();
  const search = Route.useSearch();
  const active = search.tab ?? defaultTab;
  const navigate = Route.useNavigate();

  const selectTab = useCallback(
    (next: string) => navigate({ search: { tab: next } }),
    [navigate]
  );

  const openSession = useCallback(
    (sessionId: string | undefined) =>
      navigate({ search: { session: sessionId, tab: "chat" } }),
    [navigate]
  );

  return (
    <section className="mx-auto max-w-3xl">
      <header className="mb-6">
        <h1 className="font-heading text-3xl text-foreground">{agent.name}</h1>
        <p className="text-muted-foreground text-sm">
          <code>{agent.slug}</code>
        </p>
      </header>
      <Tabs onValueChange={selectTab} value={active}>
        <TabsList>
          {agentTabs.map((agentTab) => (
            <TabsTrigger key={agentTab.id} value={agentTab.id}>
              {agentTab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {agentTabs.map((agentTab) => (
          <TabsContent className="pt-6" key={agentTab.id} value={agentTab.id}>
            <agentTab.Panel
              agent={agent}
              openSession={openSession}
              sessionId={search.session}
            />
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}
