import { createFileRoute, redirect } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useMemo } from "react";
import { z } from "zod";
import { agentNameMap } from "#/components/inbox/inbox-logic";
import { NewThreadForm } from "#/components/inbox/new-thread-form";
import { ThreadList } from "#/components/inbox/thread-list";
import { ThreadPanel } from "#/components/inbox/thread-panel";
import { usePolledQuery } from "#/components/inbox/use-polled-query";
import { getTrpc } from "#/integrations/trpc/client";
import type { InboxThread } from "#/integrations/trpc/types";

const searchSchema = z.object({
  thread: z.string().min(1).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/inbox")({
  validateSearch: (search) => searchSchema.parse(search),
  loader: async () => {
    try {
      const [threads, agents, me] = await Promise.all([
        getTrpc().inbox.listThreads.query(),
        getTrpc().agents.list.query({}),
        getTrpc().me.query(),
      ]);
      return { agents, threads, userId: me.userId };
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
      <aside className="flex flex-col gap-6">
        <h1 className="font-heading text-3xl text-foreground">Inbox</h1>
        <NewThreadForm onCreated={openThread} />
        {list.error === null ? null : (
          <p className="text-destructive text-sm">{list.error}</p>
        )}
        <ThreadList activeId={threadId} threads={threads} />
      </aside>
      <div className="min-w-0">
        {threadId === undefined ? (
          <p className="text-muted-foreground text-sm">
            Pick a thread, or start a new one.
          </p>
        ) : (
          <ThreadPanel
            agentNames={agentNames}
            key={threadId}
            onPosted={list.refresh}
            threadId={threadId}
            userId={userId}
          />
        )}
      </div>
    </section>
  );
}
