import { createFileRoute, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { useAssistantLocation } from "#/components/assistant/assistant-location";
import { ConversationList } from "#/components/conversations/conversation-list";
import {
  type ConversationListItem,
  fromRow,
} from "#/components/conversations/conversation-logic";
import { agentNameMap } from "#/components/inbox/inbox-logic";
import { SessionFilters } from "#/components/sessions/session-filters";
import { ORIGIN_VALUES } from "#/components/sessions/sessions-logic";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";

const PAGE = 30;

const searchSchema = z.object({
  agent: z.string().min(1).optional().catch(undefined),
  origin: z.enum(ORIGIN_VALUES).optional().catch(undefined),
  q: z.string().min(1).max(200).optional().catch(undefined),
  working: z.literal(true).optional().catch(undefined),
});
type Search = z.infer<typeof searchSchema>;

const filtersOf = (search: Search) => ({
  agentId: search.agent,
  origin: search.origin,
  query: search.q,
  working: search.working,
});

export const Route = createFileRoute("/_app/sessions")({
  validateSearch: (search) => searchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    try {
      const [rows, agents] = await Promise.all([
        getTrpc().conversations.list.query({ ...filtersOf(deps), limit: PAGE }),
        getTrpc().agents.list.query({ includeArchived: true }),
      ]);
      return { agents, rows };
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
  component: SessionsPage,
});

type Rows = RouterOutputs["conversations"]["list"];

function History({
  agents,
  initial,
  search,
}: {
  agents: RouterOutputs["agents"]["list"];
  initial: Rows;
  search: Search;
}) {
  const { open } = useAssistantLocation();
  const [rows, setRows] = useState(initial);
  const [more, setMore] = useState(initial.length >= PAGE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = useMemo(() => agentNameMap(agents), [agents]);
  const items = useMemo(
    () => rows.map((row) => fromRow(row, names)),
    [rows, names]
  );
  const select = useCallback(
    (item: ConversationListItem) => {
      if (item.kind === "assistant") {
        open(item.id);
      }
    },
    [open]
  );
  const loadMore = useCallback(async () => {
    const last = rows.at(-1);
    if (!last || loading) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const page = await getTrpc().conversations.list.query({
        ...filtersOf(search),
        cursor: last.cursor,
        limit: PAGE,
      });
      setRows((current) => [...current, ...page]);
      setMore(page.length >= PAGE);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not load more."
      );
    } finally {
      setLoading(false);
    }
  }, [rows, loading, search]);
  return (
    <>
      <ConversationList
        activeId={null}
        emptyText="No conversations."
        items={items}
        label="Conversations"
        loadingMore={loading}
        onLoadMore={more ? loadMore : undefined}
        onSelect={select}
        showKind
      />
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function SessionsPage() {
  const { agents, rows } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const change = useCallback(
    (patch: Partial<Search>) =>
      navigate({ search: (previous) => ({ ...previous, ...patch }) }),
    [navigate]
  );
  const changeAgent = useCallback(
    (next: string | undefined) => change({ agent: next }),
    [change]
  );
  const changeOrigin = useCallback(
    (next: Search["origin"]) => change({ origin: next }),
    [change]
  );
  const changeQuery = useCallback(
    (next: string | undefined) => change({ q: next }),
    [change]
  );
  const changeWorking = useCallback(
    (next: boolean) => change({ working: next ? true : undefined }),
    [change]
  );

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="font-heading text-3xl text-foreground">Conversations</h1>
      <SessionFilters
        agentId={search.agent}
        agents={agents}
        onAgentChange={changeAgent}
        onOriginChange={changeOrigin}
        onQueryChange={changeQuery}
        onWorkingChange={changeWorking}
        origin={search.origin}
        query={search.q}
        working={search.working === true}
      />
      <History
        agents={agents}
        initial={rows}
        key={JSON.stringify(search)}
        search={search}
      />
    </section>
  );
}
