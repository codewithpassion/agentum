import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { JobsPanel } from "#/components/jobs/jobs-panel";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

export const PAGE_HEADING = "Jobs";

export const Route = createFileRoute("/_app/jobs")({
  loader: async () =>
    loadOrLogin(async () => await getTrpc().agents.list.query({})),
  component: JobsPage,
});

function JobsPage() {
  const agents = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const openKeys = useCallback(
    (agentId: string) =>
      navigate({
        params: { agentId },
        search: { tab: "keys" },
        to: "/agents/$agentId",
      }),
    [navigate]
  );
  return (
    <section className="mx-auto flex max-w-4xl flex-col gap-6">
      <h1 className="font-heading text-3xl text-foreground">{PAGE_HEADING}</h1>
      <JobsPanel agents={agents} onOpenKeys={openKeys} />
    </section>
  );
}
