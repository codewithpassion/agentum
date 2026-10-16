import { EVENT_TYPES } from "@repo/db/shared";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { type ComponentProps, useCallback } from "react";
import { z } from "zod";
import { agentNameMap } from "#/components/inbox/inbox-logic";
import { LogFilters } from "#/components/log/log-filters";
import { dayRangeFilters, LOG_PAGE_SIZE } from "#/components/log/log-logic";
import { LogPager } from "#/components/log/log-pager";
import { LogTable } from "#/components/log/log-table";
import { getTrpc } from "#/integrations/trpc/client";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type FilterPatch = Parameters<ComponentProps<typeof LogFilters>["onChange"]>[0];

const searchSchema = z.object({
  agent: z.string().min(1).optional().catch(undefined),
  from: z.string().regex(DAY_PATTERN).optional().catch(undefined),
  page: z.number().int().min(0).optional().catch(undefined),
  to: z.string().regex(DAY_PATTERN).optional().catch(undefined),
  type: z.enum(EVENT_TYPES).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/log")({
  validateSearch: (search) => searchSchema.parse(search),
  loaderDeps: ({ search }) => ({
    agent: search.agent,
    from: search.from,
    page: search.page,
    to: search.to,
    type: search.type,
  }),
  loader: async ({ deps }) => {
    try {
      const [log, agents] = await Promise.all([
        getTrpc().events.list.query({
          agentId: deps.agent,
          limit: LOG_PAGE_SIZE,
          page: deps.page ?? 0,
          types: deps.type === undefined ? undefined : [deps.type],
          ...dayRangeFilters(deps.from, deps.to),
        }),
        getTrpc().agents.list.query({ includeArchived: true }),
      ]);
      return { agents, log };
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
  component: LogPage,
});

function LogPage() {
  const { agents, log } = Route.useLoaderData();
  const { agent, from, page, to, type } = Route.useSearch();
  const navigate = Route.useNavigate();

  const changeFilters = useCallback(
    (patch: FilterPatch) =>
      navigate({
        search: (previous) => ({ ...previous, ...patch, page: undefined }),
      }),
    [navigate]
  );

  const changePage = useCallback(
    (next: number) =>
      navigate({
        search: (previous) => ({
          ...previous,
          page: next === 0 ? undefined : next,
        }),
      }),
    [navigate]
  );

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-6">
      <h1 className="font-heading text-3xl text-foreground">Log</h1>
      <LogFilters
        agentId={agent}
        agents={agents}
        from={from}
        onChange={changeFilters}
        to={to}
        type={type}
      />
      <LogTable agentNames={agentNameMap(agents)} entries={log.entries} />
      <LogPager
        hasMore={log.hasMore}
        onPageChange={changePage}
        page={page ?? 0}
      />
    </section>
  );
}
