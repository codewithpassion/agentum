/** biome-ignore-all lint/performance/noJsxPropsBind: Collaboration actions capture trusted records and current drafts. */
import { readableMentions } from "@repo/protocol/member-mentions";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { MemberMention } from "#/components/live-artifacts/member-mention";
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
import { AgentComposer, AgentTranscript } from "../live-artifacts/agent-thread";
import { type LiveOutputs, liveApi } from "../live-artifacts/live-api";
import { Suggestions } from "../live-artifacts/suggestions";
import type { DeckWhere } from "./ports";
import type { TicketedDeckRoom } from "./room-provider";

export function DeckCollaboration({
  artifactId,
  room,
  intent,
}: {
  artifactId: string;
  room: TicketedDeckRoom;
  intent?: { kind: "ask" | "comment"; where: DeckWhere };
}) {
  const [session, setSession] = useState<LiveOutputs["session"]>(null);
  const [agents, setAgents] = useState<RouterOutputs["agents"]["list"]>([]);
  const [threads, setThreads] = useState<LiveOutputs["threads"]>({ items: [] });
  const pages = useRef({ changes: 1, threads: 1 });
  const [changes, setChanges] = useState<LiveOutputs["changes"]>({ items: [] });
  const [revertId, setRevertId] = useState<string>();
  const [error, setError] = useState<string>();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const refresh = useCallback(async () => {
    try {
      const [nextSession, nextAgents, nextThreads, nextChanges] =
        await Promise.all([
          liveApi.session.query({ artifactId }),
          getTrpc().agents.list.query({}),
          loadPages(
            (cursor) =>
              liveApi.threads.query({ artifactId, cursor, limit: 100 }),
            pages.current.threads
          ),
          loadPages(
            (cursor) =>
              liveApi.changes.query({ artifactId, cursor, limit: 100 }),
            pages.current.changes
          ),
        ]);
      setSession(nextSession);
      setAgents(nextAgents);
      setThreads(nextThreads);
      setChanges(nextChanges);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Collaboration unavailable"
      );
    }
  }, [artifactId]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
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
      setError(cause instanceof Error ? cause.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };
  const canComment = room.role !== "viewer";
  const canEdit = room.role === "owner" || room.role === "editor";
  const where = intent?.where;
  return (
    <DeckPanelFrame intent={intent}>
      <Suggestions artifactId={artifactId} canEdit={canEdit} />
      {Boolean(error) && <p role="alert">{error}</p>}
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
      {session !== null && (
        <AgentTranscript
          agentName={
            agents.find((agent) => agent.id === session.agentId)?.name ??
            "Agent"
          }
          sessionId={session.id}
        />
      )}
      <AgentComposer
        artifactId={artifactId}
        beforeSend={where ? () => room.confirmLocation(where) : undefined}
        canAsk={canComment && Boolean(session)}
        onSent={refresh}
        selection={
          where
            ? `Slide ${where.slideNumber} (${where.slideId}); elements: ${where.elementIds.join(", ") || "whole slide"}`
            : undefined
        }
      />
      <h2>Comments</h2>
      {canComment && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              await liveApi.comment.mutate({
                anchor: where
                  ? {
                      detached: false,
                      elementId: where.elementIds[0],
                      kind: "deck",
                      slideId: where.slideId,
                    }
                  : undefined,
                artifactId,
                body,
                requestId,
              });
              setBody("");
              setRequestId(crypto.randomUUID());
            });
          }}
        >
          <label>
            Comment
            <textarea
              aria-label="Comment"
              maxLength={4096}
              onChange={(event) => {
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
          <button disabled={busy || !body.trim()} type="submit">
            Post comment
          </button>
        </form>
      )}
      {threads.items.map((thread) => (
        <article
          aria-label="Comment thread"
          id={`comment-${thread.id}`}
          key={thread.id}
        >
          {thread.anchor?.kind === "deck" && (
            <p>
              Slide {thread.anchor.slideId}
              {thread.anchor.elementId ? ` · ${thread.anchor.elementId}` : ""}
              {thread.anchor.detached ? " · Detached" : ""}
            </p>
          )}
          {thread.comments.map((comment) => (
            <div key={comment.id}>
              <b>
                {room.participants.find(
                  (person) => person.id === comment.authorId
                )?.name ?? comment.authorId}
              </b>
              <p>{readableMentions(comment.body)}</p>
            </div>
          ))}
          {canComment && !thread.resolvedAt && (
            <DeckReply
              artifactId={artifactId}
              onSaved={refresh}
              threadId={thread.id}
            />
          )}
          {canComment && !thread.resolvedAt && (
            <button
              disabled={busy}
              onClick={() =>
                run(() => liveApi.resolve.mutate({ threadId: thread.id }))
              }
              type="button"
            >
              Resolve thread
            </button>
          )}
        </article>
      ))}
      {Boolean(threads.next) && (
        <button
          disabled={busy}
          onClick={() =>
            run(() => {
              pages.current.threads += 1;
              return Promise.resolve();
            })
          }
          type="button"
        >
          More comments
        </button>
      )}
      <details>
        <summary>Agent changes</summary>
        {changes.items.map((change) => (
          <article key={change.id}>
            <p>{change.summary}</p>
            <time>{change.createdAt}</time>
            <a href={`/tasks/${encodeURIComponent(change.runId)}`}>Open run</a>
            {change.revertedAt ? (
              <p>Reverted</p>
            ) : (
              canEdit && (
                <button
                  disabled={busy}
                  onClick={() => setRevertId(change.id)}
                  type="button"
                >
                  Revert change
                </button>
              )
            )}
          </article>
        ))}
        {Boolean(changes.next) && (
          <button
            disabled={busy}
            onClick={() =>
              run(() => {
                pages.current.changes += 1;
                return Promise.resolve();
              })
            }
            type="button"
          >
            More changes
          </button>
        )}
      </details>
      {canEdit && revertId !== undefined && (
        <section aria-label="Confirm revert" role="alertdialog">
          <p>Revert this agent change, preserving later human edits?</p>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await liveApi.revertChange.mutate({ changeId: revertId });
                setRevertId(undefined);
              })
            }
            type="button"
          >
            Confirm revert
          </button>
          <button onClick={() => setRevertId(undefined)} type="button">
            Cancel revert
          </button>
        </section>
      )}
    </DeckPanelFrame>
  );
}

function DeckPanelFrame({
  children,
  intent,
}: {
  children: ReactNode;
  intent?: object;
}) {
  const [mobile, setMobile] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (intent) {
      setOpen(true);
    }
  }, [intent]);
  if (!mobile) {
    return (
      <aside aria-label="Deck collaboration" className="ld-collaboration">
        {children}
      </aside>
    );
  }
  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetTrigger asChild>
        <button className="min-h-10 rounded border p-2" type="button">
          Agent and comments
        </button>
      </SheetTrigger>
      <SheetContent className="max-h-[88dvh] overflow-y-auto" side="bottom">
        <SheetHeader>
          <SheetTitle>Deck collaboration</SheetTitle>
          <SheetDescription>
            Shared agent thread and slide or element comments.
          </SheetDescription>
        </SheetHeader>
        <div className="ld-collaboration">{children}</div>
      </SheetContent>
    </Sheet>
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
function DeckReply({
  artifactId,
  threadId,
  onSaved,
}: {
  artifactId: string;
  threadId: string;
  onSaved: () => Promise<void>;
}) {
  const [body, setBody] = useState("");
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
      await liveApi.comment.mutate({ artifactId, body, requestId, threadId });
      setBody("");
      setRequestId(crypto.randomUUID());
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not post reply");
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
      <label>
        Reply
        <textarea
          aria-label="Reply"
          disabled={busy}
          maxLength={4096}
          onChange={(event) => {
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
      <button disabled={busy || !body.trim()} type="submit">
        Post reply
      </button>
      {Boolean(error) && <p role="alert">{error}</p>}
    </form>
  );
}
