import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AssistantPage } from "#/components/assistant/assistant-page";
import { getTrpc } from "#/integrations/trpc/client";

export const Route = createFileRoute("/_app/assistant")({
  validateSearch: z.object({ c: z.string().min(1).max(200).optional() }),
  loaderDeps: ({ search }) => ({ c: search.c }),
  loader: async ({ deps }) => {
    const client = getTrpc();
    const [initialList, initial, agents, key, me, mine] = await Promise.all([
      client.assistant.list.query(),
      deps.c ? client.assistant.get.query({ conversationId: deps.c }) : null,
      client.agents.list.query({ includeArchived: false }),
      client.managedKeys.status.query(),
      client.me.query(),
      client.workspaces.mine.query(),
    ]);
    return {
      initialList,
      initial,
      agents,
      hasKey: key.configured,
      admin: mine.some(
        (workspace) =>
          workspace.workspaceId === me.workspaceId &&
          workspace.role === "org:admin"
      ),
    };
  },
  component: AssistantRoute,
});

function AssistantRoute() {
  const data = Route.useLoaderData();
  const { c } = Route.useSearch();
  return <AssistantPage {...data} key={c ?? "new"} />;
}
