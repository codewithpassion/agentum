/** biome-ignore-all lint/performance/noJsxPropsBind: Panel controls capture their trusted record IDs. */

import type { LiveCommentThread } from "@repo/protocol/live";
import { readableMentions } from "@repo/protocol/member-mentions";
import type { Editor } from "@tiptap/core";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  createAbsolutePositionFromRelativePosition,
  createRelativePositionFromJSON,
} from "yjs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "#/components/ui/sheet";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { AgentComposer, AgentTranscript } from "./agent-thread";
import { resolveRelative } from "./editor-binding";
import type { EditorSelection } from "./editor-ports";
import { ToolButton } from "./editor-toolbar";
import { type LiveOutputs, liveApi } from "./live-api";
import { MemberMention } from "./member-mention";
import type { TicketedRoom } from "./room-provider";
import { Suggestions } from "./suggestions";
import { useAgentAttachment } from "./use-agent-attachment";

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
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    if (window.location.hash.startsWith("#comment-")) {
      setTab("comments");
      setMobileOpen(true);
    }
  }, []);
  const canComment = room.role !== "viewer";
  const canEdit = room.role === "owner" || room.role === "editor";
  const pageCounts = useRef({ changes: 1, threads: 1 });
  const refresh = useCallback(async () => {
    try {
      const [nextSession, nextThreads, nextChanges, nextAgents] =
        await Promise.all([
          liveApi.session.query({ artifactId }),
          loadPages(
            (cursor) =>
              liveApi.threads.query({ artifactId, cursor, limit: 100 }),
            pageCounts.current.threads
          ),
          loadPages(
            (cursor) =>
              liveApi.changes.query({ artifactId, cursor, limit: 100 }),
            pageCounts.current.changes
          ),
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
  const {
    selection,
    setSelection,
    sent: asked,
    clear: clearAttachment,
  } = useAgentAttachment(room, refresh);
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
  }, [intent, room, setSelection]);
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
  const selectionBeforeSend = () =>
    selection ? room.confirmSelection(selection) : Promise.resolve();
  const agentName =
    agents.find((agent) => agent.id === session?.agentId)?.name ?? "Agent";
  return (
    <PanelFrame onOpenChange={setMobileOpen} open={mobileOpen}>
      <Suggestions artifactId={artifactId} canEdit={canEdit} />
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
              intent?.kind === "ask" ? selectionBeforeSend : undefined
            }
            canAsk={canComment && Boolean(session)}
            onSent={asked}
            selection={intent?.kind === "ask" ? selection?.text : undefined}
          />
          {selection !== undefined && (
            <ToolButton onClick={clearAttachment}>Clear selection</ToolButton>
          )}
        </>
      )}
      {tab === "comments" && (
        <>
          {canComment && (
            <CommentForm
              artifactId={artifactId}
              key={intent?.nonce}
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
                  pageCounts.current.threads += 1;
                  await refresh();
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
                    pageCounts.current.changes += 1;
                    await refresh();
                  })
                }
              >
                More changes
              </ToolButton>
            </li>
          )}
        </ul>
      )}
    </PanelFrame>
  );
}

async function loadPages<T>(
  load: (cursor?: string) => Promise<{ items: T[]; next?: string }>,
  count: number
) {
  const items: T[] = [];
  let next: string | undefined;
  for (let index = 0; index < count; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Each page requires the preceding cursor.
    const page = await load(next);
    items.push(...page.items);
    ({ next } = page);
    if (!next) {
      break;
    }
  }
  return { items, next };
}

function PanelFrame({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  if (!mobile) {
    return (
      <aside
        aria-label="Artifact collaboration"
        className="live-collaboration-panel"
      >
        {children}
      </aside>
    );
  }
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetTrigger asChild>
        <button className="min-h-10 p-2" type="button">
          Agent, comments and changes
        </button>
      </SheetTrigger>
      <SheetContent
        className="live-collaboration-sheet max-h-[88dvh] overflow-y-auto"
        side="bottom"
      >
        <SheetHeader>
          <SheetTitle>Artifact collaboration</SheetTitle>
          <SheetDescription>
            Shared agent thread, anchored comments and agent changes.
          </SheetDescription>
        </SheetHeader>
        <div className="live-collaboration-panel">{children}</div>
      </SheetContent>
    </Sheet>
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
  let postLabel = threadId ? "Post reply" : "Post comment";
  if (!threadId && toAgent && error) {
    postLabel = "Retry agent delivery";
  }
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
            setError(undefined);
            setBody(event.target.value);
            setRequestId(crypto.randomUUID());
          }}
          value={body}
        />
      </label>
      <MemberMention
        artifactId={artifactId}
        disabled={busy}
        onInsert={(token) => {
          setBody((old) => `${old}${old ? " " : ""}${token} `);
          setRequestId(crypto.randomUUID());
        }}
      />
      {!threadId && (
        <label>
          <input
            checked={toAgent}
            disabled={busy}
            onChange={(event) => {
              setError(undefined);
              setToAgent(event.target.checked);
              setRequestId(crypto.randomUUID());
            }}
            type="checkbox"
          />
          Address agent
        </label>
      )}
      <ToolButton disabled={busy || !body.trim()} onClick={submit}>
        {busy ? <span>Posting…</span> : <span>{postLabel}</span>}
      </ToolButton>
      {Boolean(error) && (
        <p role="alert">{error} Retry preserves the request ID.</p>
      )}
    </form>
  );
}

export function CommentThread({
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
    <article
      aria-label="Comment thread"
      className="live-comment-thread"
      id={`comment-${thread.id}`}
    >
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
          <p>{readableMentions(comment.body)}</p>
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
