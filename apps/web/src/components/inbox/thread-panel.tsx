import { RAIL_REFRESH_EVENT } from "@repo/db/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { threadWaits } from "#/components/inbox/inbox-logic";
import { PostComposer } from "#/components/inbox/post-composer";
import { PostList } from "#/components/inbox/post-list";
import { usePolledQuery } from "#/components/inbox/use-polled-query";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";

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

  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const dismiss = useCallback(async () => {
    setDismissing(true);
    setDismissError(null);
    try {
      await getTrpc().inbox.clearAttention.mutate({ threadId });
      window.dispatchEvent(new Event(RAIL_REFRESH_EVENT));
      refreshView();
    } catch (cause) {
      setDismissError(errorMessage(cause));
    } finally {
      setDismissing(false);
    }
  }, [refreshView, threadId]);

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
      {threadWaits(view.data.thread, view.data.posts) ? (
        <div className="flex flex-col gap-2">
          <div>
            <Button
              disabled={dismissing}
              onClick={dismiss}
              size="sm"
              type="button"
              variant="outline"
            >
              Dismiss
            </Button>
          </div>
          {dismissError === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {dismissError}
            </p>
          )}
        </div>
      ) : null}
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
