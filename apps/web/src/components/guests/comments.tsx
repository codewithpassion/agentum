/** biome-ignore-all lint/performance/noJsxPropsBind: Guest callbacks capture thread identity. */
import type { GuestThread } from "@repo/protocol/guest";
import type { CommentAnchor } from "@repo/protocol/live";
import { useCallback, useEffect, useState } from "react";
import type { EditorRole } from "../live-artifacts/editor-ports";
import { guestHttp } from "./http";
import type { GuestServices } from "./services";
export function GuestComments({
  services,
  role,
  anchor,
  failed,
}: {
  services: GuestServices;
  role: EditorRole;
  anchor?: CommentAnchor;
  failed: (message: string) => void;
}) {
  const [threads, setThreads] = useState<GuestThread[]>([]);
  const [body, setBody] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(
    () =>
      guestHttp
        .json<GuestThread[]>(services.endpoint("threads"))
        .then(setThreads)
        .catch((cause: Error) => failed(cause.message)),
    [services, failed]
  );
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (cause) {
      failed(cause instanceof Error ? cause.message : "Comment failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Comments" className="guest-comments">
      <h2>Comments</h2>
      <p>
        Use Ask agent above to request help. Comments here are shared with
        everyone who can access this artifact.
      </p>
      {threads.map((thread) => (
        <article key={thread.id}>
          <p>
            {thread.quote}
            {thread.resolvedAt ? " · Resolved" : ""}
          </p>
          {thread.comments
            .filter((comment) => !comment.deletedAt)
            .map((comment) => (
              <p key={comment.id}>
                <strong>{comment.authorKind}</strong>: {comment.body}
              </p>
            ))}
          {role !== "viewer" && !thread.resolvedAt && (
            <>
              <button onClick={() => setReply(thread.id)} type="button">
                Reply
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  run(() =>
                    guestHttp.json(services.endpoint("resolve"), {
                      threadId: thread.id,
                    })
                  )
                }
                type="button"
              >
                Resolve
              </button>
            </>
          )}
        </article>
      ))}
      {role !== "viewer" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              await guestHttp.json(services.endpoint("comment"), {
                body,
                ...(reply ? { threadId: reply } : { anchor }),
              });
              setBody("");
            });
          }}
        >
          <label>
            {reply ? "Reply to thread" : "New comment"}
            <textarea
              maxLength={4096}
              onChange={(event) => setBody(event.target.value)}
              required
              value={body}
            />
          </label>
          {Boolean(reply) && (
            <button onClick={() => setReply("")} type="button">
              Cancel reply
            </button>
          )}
          <button disabled={busy || !body.trim()} type="submit">
            Post comment
          </button>
        </form>
      )}
    </section>
  );
}
