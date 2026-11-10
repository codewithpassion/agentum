import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { agentNameMap } from "#/components/inbox/inbox-logic";
import { QaBoard } from "#/components/qa/qa-board";
import { type QaFilter, statusOfFilter } from "#/components/qa/qa-logic";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

const searchSchema = z.object({
  status: z.enum(["open", "answered", "all"]).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/qa/")({
  validateSearch: (search) => searchSchema.parse(search),
  loaderDeps: ({ search }) => ({ status: search.status }),
  loader: async ({ deps }) =>
    loadOrLogin(async () => {
      const [page, agents, me] = await Promise.all([
        getTrpc().qa.list.query({
          status: statusOfFilter(deps.status ?? "open"),
        }),
        getTrpc().agents.list.query({ includeArchived: true }),
        getTrpc().me.query(),
      ]);
      return { agentNames: agentNameMap(agents), page, userId: me.userId };
    }),
  component: QaListPage,
});

function QaListPage() {
  const { agentNames, page, userId } = Route.useLoaderData();
  const { status } = Route.useSearch();
  const filter: QaFilter = status ?? "open";
  // A new filter is a new board, so the poll and the older pages start over.
  return (
    <QaBoard
      agentNames={agentNames}
      filter={filter}
      initial={page}
      key={filter}
      userId={userId}
    />
  );
}
