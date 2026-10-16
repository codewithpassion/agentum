import { createFileRoute, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback } from "react";
import { z } from "zod";
import { agentNameMap } from "#/components/inbox/inbox-logic";
import { SessionFilters } from "#/components/sessions/session-filters";
import { SessionList } from "#/components/sessions/session-list";
import { SessionTranscriptPanel } from "#/components/sessions/session-transcript";
import { ORIGIN_VALUES } from "#/components/sessions/sessions-logic";
import { getTrpc } from "#/integrations/trpc/client";

const searchSchema = z.object({
  agent: z.string().min(1).optional().catch(undefined),
  origin: z.enum(ORIGIN_VALUES).optional().catch(undefined),
  session: z.string().min(1).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/sessions")({
  validateSearch: (search) => searchSchema.parse(search),
  loaderDeps: ({ search }) => ({ agent: search.agent, origin: search.origin }),
  loader: async ({ deps }) => {
    try {
      const [sessions, agents] = await Promise.all([
        getTrpc().sessions.list.query({
          agentId: deps.agent,
          origin: deps.origin,
        }),
        getTrpc().agents.list.query({ includeArchived: true }),
      ]);
      return { agents, sessions };
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

function SessionsPage() {
  const { agents, sessions } = Route.useLoaderData();
  const { agent, origin, session } = Route.useSearch();
  const navigate = Route.useNavigate();

  const changeAgent = useCallback(
    (next: string | undefined) =>
      navigate({
        search: (previous) => ({
          ...previous,
          agent: next,
          session: undefined,
        }),
      }),
    [navigate]
  );

  const changeOrigin = useCallback(
    (next: z.infer<typeof searchSchema>["origin"]) =>
      navigate({
        search: (previous) => ({
          ...previous,
          origin: next,
          session: undefined,
        }),
      }),
    [navigate]
  );

  return (
    <section className="mx-auto grid max-w-6xl gap-8 md:grid-cols-[22rem_1fr]">
      <aside className="flex min-w-0 flex-col gap-6">
        <h1 className="font-heading text-3xl text-foreground">Sessions</h1>
        <SessionFilters
          agentId={agent}
          agents={agents}
          onAgentChange={changeAgent}
          onOriginChange={changeOrigin}
          origin={origin}
        />
        <SessionList
          activeId={session}
          agentNames={agentNameMap(agents)}
          sessions={sessions}
        />
      </aside>
      <div className="min-w-0">
        {session === undefined ? (
          <p className="text-muted-foreground text-sm">
            Pick a session to read its transcript.
          </p>
        ) : (
          <SessionTranscriptPanel key={session} sessionId={session} />
        )}
      </div>
    </section>
  );
}
