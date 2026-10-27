/** biome-ignore-all lint/performance/noJsxPropsBind: Guest callbacks capture thread identity. */
/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: The mutable mount ref changes in effect cleanup across awaited requests. */
import type { GuestThread } from "@repo/protocol/guest";
import type { CommentAnchor, GuestGrant } from "@repo/protocol/live";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorRole } from "../live-artifacts/editor-ports";
import { guestHttp } from "./http";
import {
  clearPendingComment,
  pendingCommentKey,
  readPendingComment,
} from "./pending-comment";
import type { GuestServices } from "./services";
export function GuestComments({
  services,
  grant,
  role,
  anchor,
  failed,
}: {
  services: GuestServices;
  grant: GuestGrant;
  role: EditorRole;
  anchor?: CommentAnchor;
  failed: (message: string) => void;
}) {
  const storageKey = pendingCommentKey(grant);
  const [pending, setPending] = useState(() => readPendingComment(storageKey));
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [threads, setThreads] = useState<GuestThread[]>([]);
  const [body, setBody] = useState(pending?.body ?? "");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [toAgent, setToAgent] = useState(Boolean(pending));
  const requestId = useRef<string | null>(null);
  const refresh = useCallback(
    () =>
      guestHttp
        .json<GuestThread[]>(services.endpoint("threads"))
        .then((value) => {
          if (alive.current) {
            setThreads(value);
          }
        })
        .catch((cause: Error) => {
          if (alive.current) {
            failed(cause.message);
          }
        }),
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
      if (!alive.current) {
        return;
      }
      await refresh();
    } catch (cause) {
      if (alive.current) {
        failed(cause instanceof Error ? cause.message : "Comment failed");
      }
    } finally {
      if (alive.current) {
        setBusy(false);
      }
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
            {thread.answeredAt ? " · Answered" : ""}
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
                disabled={busy || Boolean(pending)}
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
              const input = pending ?? {
                body,
                ...(!reply && toAgent
                  ? { requestId: requestId.current, toAgent: true }
                  : {}),
                ...(reply ? { threadId: reply } : { anchor }),
              };
              if (input.toAgent) {
                setPending(input);
                try {
                  sessionStorage.setItem(storageKey, JSON.stringify(input));
                } catch {
                  /* Optional storage. */
                }
              }
              await guestHttp.json(services.endpoint("comment"), input);
              if (!alive.current) {
                return;
              }
              clearPendingComment(storageKey, input.requestId ?? "");
              setPending(undefined);
              setBody("");
              requestId.current = null;
            });
          }}
        >
          <label>
            {reply ? "Reply to thread" : "New comment"}
            <textarea
              disabled={busy || Boolean(pending)}
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
                disabled={busy || Boolean(pending)}
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
          {Boolean(pending) && (
            <button
              disabled={busy}
              onClick={() => {
                if (pending?.requestId) {
                  clearPendingComment(storageKey, pending.requestId);
                }
                setPending(undefined);
                requestId.current = null;
              }}
              type="button"
            >
              Discard saved comment retry
            </button>
          )}
          <button disabled={busy || !body.trim()} type="submit">
            {pending ? "Retry addressed comment" : "Post comment"}
          </button>
        </form>
      )}
    </section>
  );
}
