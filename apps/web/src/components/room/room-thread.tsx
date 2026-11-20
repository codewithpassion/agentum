import { RAIL_REFRESH_EVENT, type Team } from "@repo/db/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { threadWaits } from "#/components/inbox/inbox-logic";
import { usePolledQuery } from "#/components/inbox/use-polled-query";
import { useFileInfos } from "#/components/thread/use-file-infos.ts";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import { MentionComposer } from "./mention-composer.tsx";
import { assignedTo, authorName, memberOfPost } from "./room-logic.ts";
import { RoomPost } from "./room-post.tsx";
import { RoomRequests } from "./room-requests.tsx";
import type { RoomDirectory, RoomMember } from "./room-types.ts";

interface RoomThreadProps {
  canPost: boolean;
  directory: RoomDirectory;
  members: readonly RoomMember[];
  onPosted: () => void;
  team: Pick<Team, "leadAgentId" | "name">;
  threadId: string;
  userId: string;
}

/** Keyed by topic id by the caller, so each open topic gets its own poll. */
export function RoomThread({
  canPost,
  directory,
  members,
  onPosted,
  team,
  threadId,
  userId,
}: RoomThreadProps) {
  const view = usePolledQuery(
    () => getTrpc().inbox.readThread.query({ threadId }),
    null
  );
  const { refresh: refreshView } = view;
  const end = useRef<HTMLDivElement>(null);
  const loaded = view.data !== null;

  // On a phone the topic opens at its latest post, by the composer. This runs
  // once per topic, so a poll never moves the page.
  useEffect(() => {
    if (loaded && window.matchMedia("(max-width: 767px)").matches) {
      end.current?.scrollIntoView({ block: "end" });
    }
  }, [loaded]);

  const posts = view.data?.posts;
  const fileIds = useMemo(
    () => [...new Set((posts ?? []).flatMap((post) => post.fileIds))],
    [posts]
  );
  const { files } = useFileInfos(fileIds);
  const postedRunIds = useMemo(
    () =>
      new Set(
        (posts ?? []).flatMap((post) =>
          post.runId === null ? [] : [post.runId]
        )
      ),
    [posts]
  );

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
        {view.error ?? "Loading topic..."}
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <h2 className="font-heading text-2xl text-foreground">
        {view.data.thread.title}
      </h2>
      {canPost && threadWaits(view.data.thread, view.data.posts) ? (
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
      {view.data.posts.length === 0 ? (
        <p className="text-muted-foreground text-sm">No posts yet.</p>
      ) : (
        <ol aria-label="Posts" className="flex flex-col gap-5">
          {view.data.posts.map((post) => {
            const author = memberOfPost(post, directory);
            return (
              <RoomPost
                assigned={assignedTo(post, team.leadAgentId, members)}
                author={author}
                authorLabel={authorName(author, userId)}
                files={files}
                key={post.id}
                post={post}
              />
            );
          })}
        </ol>
      )}
      <RoomRequests
        directory={directory}
        postedRunIds={postedRunIds}
        threadId={threadId}
      />
      {canPost ? (
        <MentionComposer
          members={members}
          onSent={handleSent}
          threadId={threadId}
        />
      ) : (
        <p className="text-muted-foreground text-sm">
          {`You are not in ${team.name}, so you can read this topic but not post.`}
        </p>
      )}
      <div ref={end} />
    </section>
  );
}
