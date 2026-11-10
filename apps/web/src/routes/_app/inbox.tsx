import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { z } from "zod";
import { agentNameMap } from "#/components/inbox/inbox-logic";
import { NewThreadForm } from "#/components/inbox/new-thread-form";
import { ThreadList } from "#/components/inbox/thread-list";
import { ThreadPanel } from "#/components/inbox/thread-panel";
import { usePolledQuery } from "#/components/inbox/use-polled-query";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";
import type { InboxThread } from "#/integrations/trpc/types";
import { cn } from "#/lib/utils.ts";

const searchSchema = z.object({
  thread: z.string().min(1).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/inbox")({
  validateSearch: (search) => searchSchema.parse(search),
  loader: async () =>
    loadOrLogin(async () => {
      const [threads, agents, me] = await Promise.all([
        getTrpc().inbox.listThreads.query(),
        getTrpc().agents.list.query({}),
        getTrpc().me.query(),
      ]);
      return { agents, threads, userId: me.userId };
    }),
  component: InboxPage,
});

function InboxPage() {
  const { agents, threads: initialThreads, userId } = Route.useLoaderData();
  const { thread: threadId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const agentNames = useMemo(() => agentNameMap(agents), [agents]);
  const list = usePolledQuery(
    () => getTrpc().inbox.listThreads.query(),
    initialThreads
  );
  const threads = list.data ?? initialThreads;
  const { refresh: refreshThreads } = list;

  const openThread = useCallback(
    (thread: InboxThread) => {
      refreshThreads();
      navigate({ search: { thread: thread.id } });
    },
    [refreshThreads, navigate]
  );

  return (
    <section className="mx-auto grid max-w-5xl gap-8 md:grid-cols-[16rem_1fr]">
      <aside
        className={cn(
          "flex flex-col gap-6",
          // Phones show the list or the open thread, not both.
          threadId !== undefined && "max-md:hidden"
        )}
      >
        <h1 className="font-heading text-3xl text-foreground">Inbox</h1>
        <NewThreadForm onCreated={openThread} />
        {list.error === null ? null : (
          <p className="text-destructive text-sm">{list.error}</p>
        )}
        <ThreadList activeId={threadId} threads={threads} />
      </aside>
      <div className={cn("min-w-0", threadId === undefined && "max-md:hidden")}>
        {threadId === undefined ? (
          <p className="text-muted-foreground text-sm">
            Pick a thread, or start a new one.
          </p>
        ) : (
          <>
            <Link
              className="mb-3 inline-flex min-h-10 items-center text-muted-foreground text-sm md:hidden"
              to="/inbox"
            >
              ‹ All threads
            </Link>
            <ThreadPanel
              agentNames={agentNames}
              key={threadId}
              onPosted={list.refresh}
              threadId={threadId}
              userId={userId}
            />
          </>
        )}
      </div>
    </section>
  );
}
