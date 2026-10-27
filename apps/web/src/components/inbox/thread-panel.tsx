import { useCallback, useEffect, useRef } from "react";
import { PostComposer } from "#/components/inbox/post-composer";
import { PostList } from "#/components/inbox/post-list";
import { usePolledQuery } from "#/components/inbox/use-polled-query";
import { getTrpc } from "#/integrations/trpc/client";

interface ThreadPanelProps {
  agentNames: ReadonlyMap<string, string>;
  onPosted: () => void;
  threadId: string;
  userId: string;
}

/** Keyed by thread id by the caller, so each open thread gets its own poll. */
export function ThreadPanel({
  agentNames,
  onPosted,
  threadId,
  userId,
}: ThreadPanelProps) {
  const view = usePolledQuery(
    () => getTrpc().inbox.readThread.query({ threadId }),
    null
  );
  const { refresh: refreshView } = view;
  const end = useRef<HTMLDivElement>(null);
  const loaded = view.data !== null;

  // On a phone the thread opens at its latest post, by the composer. This
  // runs once per thread, so a poll never moves the page.
  useEffect(() => {
    if (loaded && window.matchMedia("(max-width: 767px)").matches) {
      end.current?.scrollIntoView({ block: "end" });
    }
  }, [loaded]);

  const handleSent = useCallback(() => {
    refreshView();
    onPosted();
  }, [refreshView, onPosted]);

  if (view.data === null) {
    return (
      <p className="text-muted-foreground text-sm">
        {view.error ?? "Loading thread..."}
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <h2 className="font-heading text-2xl text-foreground">
        {view.data.thread.title}
      </h2>
      {view.error === null ? null : (
        <p className="text-destructive text-sm">{view.error}</p>
      )}
      <PostList
        agentNames={agentNames}
        posts={view.data.posts}
        userId={userId}
      />
      <PostComposer onSent={handleSent} threadId={threadId} />
      <div ref={end} />
    </section>
  );
}
