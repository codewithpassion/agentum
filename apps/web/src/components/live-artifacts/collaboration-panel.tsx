/** biome-ignore-all lint/performance/noJsxPropsBind: Panel controls capture their trusted record IDs. */

import type { LiveCommentThread } from "@repo/protocol/live";
import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useState } from "react";
import {
  createAbsolutePositionFromRelativePosition,
  createRelativePositionFromJSON,
} from "yjs";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { AgentComposer, AgentTranscript } from "./agent-thread";
import { resolveRelative } from "./editor-binding";
import type { EditorSelection } from "./editor-ports";
import { ToolButton } from "./editor-toolbar";
import { type LiveOutputs, liveApi } from "./live-api";
import type { TicketedRoom } from "./room-provider";

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : "The action failed";
export interface PanelIntent {
  kind: "ask" | "comment";
  nonce: string;
  selection: EditorSelection;
}
export function CollaborationPanel({
  artifactId,
  room,
  intent,
  editor,
}: {
  artifactId: string;
  room: TicketedRoom;
  intent?: PanelIntent;
  editor: Editor | null;
}) {
  const [tab, setTab] = useState<"agent" | "comments" | "changes">("agent");
  const [session, setSession] = useState<LiveOutputs["session"]>(null);
  const [agents, setAgents] = useState<RouterOutputs["agents"]["list"]>([]);
  const [threads, setThreads] = useState<LiveOutputs["threads"]>({ items: [] });
  const [changes, setChanges] = useState<LiveOutputs["changes"]>({ items: [] });
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revertId, setRevertId] = useState<string>();
  const [selection, setSelection] = useState<EditorSelection>();
  const [mobileOpen, setMobileOpen] = useState(false);
  const canComment = room.role !== "viewer";
  const canEdit = room.role === "owner" || room.role === "editor";
  const refresh = useCallback(async () => {
    try {
      const [nextSession, nextThreads, nextChanges, nextAgents] =
        await Promise.all([
          liveApi.session.query({ artifactId }),
          liveApi.threads.query({ artifactId, limit: 100 }),
          liveApi.changes.query({ artifactId, limit: 100 }),
          getTrpc().agents.list.query({}),
        ]);
      setSession(nextSession);
      setThreads(nextThreads);
      setChanges(nextChanges);
      setAgents(nextAgents);
      setLoaded(true);
      setError(undefined);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [artifactId]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!intent) {
      return;
    }
    setSelection(intent.selection);
    setTab(intent.kind === "ask" ? "agent" : "comments");
    setMobileOpen(true);
    room.select(intent.selection.start, intent.selection.end);
  }, [intent, room]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const agentName =
    agents.find((agent) => agent.id === session?.agentId)?.name ?? "Agent";
  return (
    <>
      <button
        className="live-panel-toggle"
        onClick={() => setMobileOpen(true)}
        type="button"
      >
        Agent, comments and changes
      </button>
      <aside
        aria-label="Artifact collaboration"
        className={`live-collaboration-panel ${mobileOpen ? "is-open" : ""}`}
      >
        <button
          className="live-panel-toggle"
          onClick={() => setMobileOpen(false)}
          type="button"
        >
          Close panel
        </button>
        <nav aria-label="Collaboration panels">
          {(["agent", "comments", "changes"] as const).map((name) => (
            <ToolButton
              aria-pressed={tab === name}
              key={name}
              onClick={() => setTab(name)}
            >
              {
                {
                  agent: "Agent thread",
                  changes: "Agent changes",
                  comments: "Comments",
                }[name]
              }
            </ToolButton>
          ))}
        </nav>
        {!loaded && <p role="status">Loading collaboration…</p>}
        {Boolean(error) && (
          <p role="alert">
            {error}
            <ToolButton onClick={refresh}>Retry</ToolButton>
          </p>
        )}
        {tab === "agent" && (
          <>
            <label>
              Agent
              <select
                aria-label="Select agent"
                disabled={!canComment || busy}
                onChange={(event) =>
                  run(() =>
                    liveApi.selectAgent.mutate({
                      agentId: event.target.value,
                      artifactId,
                    })
                  )
                }
                value={session?.agentId ?? ""}
              >
                <option disabled value="">
                  Select an agent
                </option>
                {agents
                  .filter((agent) => agent.status === "active")
                  .map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
              </select>
            </label>
            {session ? (
              <AgentTranscript
                agentName={agentName}
                key={session.id}
                sessionId={session.id}
              />
            ) : (
              <p>Select an agent to open this artifact’s shared thread.</p>
            )}
            <AgentComposer
              artifactId={artifactId}
              beforeSend={
                intent?.kind === "ask" && selection
                  ? () => room.confirmSelection(selection)
                  : undefined
              }
              canAsk={canComment && Boolean(session)}
              onSent={refresh}
              selection={intent?.kind === "ask" ? selection?.text : undefined}
            />
            {selection !== undefined && (
              <ToolButton onClick={() => setSelection(undefined)}>
                Clear selection
              </ToolButton>
            )}
          </>
        )}
        {tab === "comments" && (
          <>
            {canComment && (
              <CommentForm
                artifactId={artifactId}
                onSaved={refresh}
                selection={selection}
              />
            )}
            {threads.items.map((thread) => (
              <CommentThread
                artifactId={artifactId}
                canComment={canComment}
                editor={editor}
                key={thread.id}
                onSaved={refresh}
                room={room}
                thread={thread}
              />
            ))}
            {Boolean(threads.next) && (
              <ToolButton
                onClick={() =>
                  run(async () => {
                    const page = await liveApi.threads.query({
                      artifactId,
                      cursor: threads.next,
                      limit: 100,
                    });
                    setThreads({
                      ...page,
                      items: [...threads.items, ...page.items],
                    });
                  })
                }
              >
                More comments
              </ToolButton>
            )}
          </>
        )}
        {revertId !== undefined && (
          <section aria-label="Confirm revert" role="alertdialog">
            <p>Revert this agent change, preserving later human edits?</p>
            <ToolButton
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await liveApi.revertChange.mutate({ changeId: revertId });
                  setRevertId(undefined);
                })
              }
            >
              Confirm revert
            </ToolButton>
            <ToolButton onClick={() => setRevertId(undefined)}>
              Cancel revert
            </ToolButton>
          </section>
        )}
        {tab === "changes" && (
          <ul>
            {changes.items.map((change) => (
              <li key={change.id}>
                <p>{change.summary}</p>
                <time>{change.createdAt}</time>{" "}
                <a href={`/tasks/${encodeURIComponent(change.runId)}`}>Run</a>
                {change.revertedAt ? (
                  <p>Reverted by {change.revertedBy}</p>
                ) : (
                  canEdit && (
                    <ToolButton
                      disabled={busy}
                      onClick={() => {
                        setRevertId(change.id);
                      }}
                    >
                      Revert
                    </ToolButton>
                  )
                )}
              </li>
            ))}
            {Boolean(changes.next) && (
              <li>
                <ToolButton
                  onClick={() =>
                    run(async () => {
                      const page = await liveApi.changes.query({
                        artifactId,
                        cursor: changes.next,
                        limit: 100,
                      });
                      setChanges({
                        ...page,
                        items: [...changes.items, ...page.items],
                      });
                    })
                  }
                >
                  More changes
                </ToolButton>
              </li>
            )}
          </ul>
        )}
      </aside>
    </>
  );
}

function CommentForm({
  artifactId,
  selection,
  threadId,
  onSaved,
}: {
  artifactId: string;
  selection?: EditorSelection;
  threadId?: string;
  onSaved: () => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [toAgent, setToAgent] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (busy || !body.trim()) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await liveApi.comment.mutate({
        anchor:
          !threadId && selection
            ? {
                detached: false,
                end: selection.end,
                kind: "document",
                start: selection.start,
              }
            : undefined,
        artifactId,
        body,
        requestId,
        threadId,
        toAgent,
      });
      setBody("");
      setRequestId(crypto.randomUUID());
      await onSaved();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {!threadId && selection && <blockquote>{selection.text}</blockquote>}
      <label>
        {threadId ? "Reply" : "Comment"}
        <textarea
          aria-label={threadId ? "Reply" : "Comment"}
          disabled={busy}
          maxLength={4096}
          onChange={(event) => {
            setBody(event.target.value);
            setRequestId(crypto.randomUUID());
          }}
          value={body}
        />
      </label>
      {!threadId && (
        <label>
          <input
            checked={toAgent}
            onChange={(event) => {
              setToAgent(event.target.checked);
              setRequestId(crypto.randomUUID());
            }}
            type="checkbox"
          />
          Address agent
        </label>
      )}
      <ToolButton disabled={busy || !body.trim()} onClick={submit}>
        {busy ? "Posting…" : "Post"}
      </ToolButton>
      {Boolean(error) && (
        <p role="alert">{error} Retry preserves the request ID.</p>
      )}
    </form>
  );
}

function CommentThread({
  artifactId,
  thread,
  room,
  editor,
  canComment,
  onSaved,
}: {
  artifactId: string;
  thread: LiveCommentThread;
  editor: Editor | null;
  room: TicketedRoom;
  canComment: boolean;
  onSaved: () => Promise<void>;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [detached, setDetached] = useState(thread.anchor?.detached ?? false);
  useEffect(() => {
    const update = () => {
      if (thread.anchor?.kind !== "document") {
        return;
      }
      const start = createAbsolutePositionFromRelativePosition(
        createRelativePositionFromJSON(thread.anchor.start),
        room.document
      );
      const end = createAbsolutePositionFromRelativePosition(
        createRelativePositionFromJSON(thread.anchor.end),
        room.document
      );
      setDetached(
        thread.anchor.detached ||
          !start ||
          !end ||
          (start.type === end.type && start.index === end.index)
      );
    };
    update();
    room.document.on("update", update);
    return () => room.document.off("update", update);
  }, [room, thread.anchor]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await onSaved();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article aria-label="Comment thread" className="live-comment-thread">
      {Boolean(thread.quote) && <blockquote>{thread.quote}</blockquote>}
      {thread.anchor?.kind === "document" && !detached && editor !== null && (
        <ToolButton
          onClick={() => {
            if (thread.anchor?.kind !== "document") {
              return;
            }
            const from = resolveRelative(editor, thread.anchor.start);
            const to = resolveRelative(editor, thread.anchor.end);
            if (
              from !== null &&
              to !== null &&
              from !== undefined &&
              to !== undefined
            ) {
              editor
                .chain()
                .focus()
                .setTextSelection({ from, to })
                .scrollIntoView()
                .run();
            }
          }}
        >
          Go to commented text
        </ToolButton>
      )}
      {Boolean(detached) && <p>Detached — the selected text was removed.</p>}
      <p>
        {thread.resolvedAt ? "Resolved" : "Open"}
        {thread.toAgent ? " · Addressed to agent" : ""}
        {thread.answeredAt ? " · Answered" : ""}
      </p>
      {thread.comments.map((comment) => (
        <div key={comment.id}>
          <b>
            {room.presence
              .getSnapshot()
              .find((person) => person.id === comment.authorId)?.name ??
              `${comment.authorKind} ${comment.authorId}`}
          </b>
          <time>{comment.createdAt}</time>
          <p>{comment.body}</p>
          {thread.toAgent && !thread.answeredAt && canComment && (
            <ToolButton
              disabled={busy}
              onClick={() =>
                run(() =>
                  liveApi.retryCommentAsk.mutate({
                    artifactId,
                    commentId: comment.id,
                    threadId: thread.id,
                  })
                )
              }
            >
              Retry agent delivery
            </ToolButton>
          )}
        </div>
      ))}
      {canComment && !thread.resolvedAt && (
        <>
          <CommentForm
            artifactId={artifactId}
            onSaved={onSaved}
            threadId={thread.id}
          />
          <ToolButton
            disabled={busy}
            onClick={() =>
              run(() => liveApi.resolve.mutate({ threadId: thread.id }))
            }
          >
            Resolve thread
          </ToolButton>
        </>
      )}
      {Boolean(error) && <p role="alert">{error}</p>}
    </article>
  );
}
