/** biome-ignore-all lint/performance/noJsxPropsBind: Guest callbacks capture thread identity. */
import type { GuestThread } from "@repo/protocol/guest";
import type { CommentAnchor } from "@repo/protocol/live";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const [toAgent, setToAgent] = useState(false);
  const requestId = useRef<string | null>(null);
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
        Comments are shared with everyone who can access this artifact. Address
        a new comment to the agent to request an answer in its thread.
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
              <button
                onClick={() => {
                  setReply(thread.id);
                  requestId.current = null;
                }}
                type="button"
              >
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
              requestId.current ??= crypto.randomUUID();
              await guestHttp.json(services.endpoint("comment"), {
                body,
                ...(!reply && toAgent
                  ? { requestId: requestId.current, toAgent: true }
                  : {}),
                ...(reply ? { threadId: reply } : { anchor }),
              });
              setBody("");
              requestId.current = null;
            });
          }}
        >
          <label>
            {reply ? "Reply to thread" : "New comment"}
            <textarea
              disabled={busy}
              maxLength={4096}
              onChange={(event) => {
                setBody(event.target.value);
                requestId.current = null;
              }}
              required
              value={body}
            />
          </label>
          {!reply && (
            <label>
              <input
                checked={toAgent}
                disabled={busy}
                onChange={(event) => {
                  setToAgent(event.target.checked);
                  requestId.current = null;
                }}
                type="checkbox"
              />
              Address to agent
            </label>
          )}
          {Boolean(reply) && (
            <button
              onClick={() => {
                setReply("");
                requestId.current = null;
              }}
              type="button"
            >
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
