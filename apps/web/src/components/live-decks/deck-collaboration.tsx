/** biome-ignore-all lint/performance/noJsxPropsBind: Collaboration actions capture trusted records and current drafts. */
import { useCallback, useEffect, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { AgentComposer, AgentTranscript } from "../live-artifacts/agent-thread";
import { type LiveOutputs, liveApi } from "../live-artifacts/live-api";
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
  const [error, setError] = useState<string>();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const refresh = useCallback(async () => {
    try {
      const [nextSession, nextAgents, nextThreads] = await Promise.all([
        liveApi.session.query({ artifactId }),
        getTrpc().agents.list.query({}),
        liveApi.threads.query({ artifactId, limit: 100 }),
      ]);
      setSession(nextSession);
      setAgents(nextAgents);
      setThreads(nextThreads);
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
  const where = intent?.where;
  return (
    <aside aria-label="Deck collaboration">
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
          <button disabled={busy || !body.trim()} type="submit">
            Post comment
          </button>
        </form>
      )}
      {threads.items.map((thread) => (
        <article aria-label="Comment thread" key={thread.id}>
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
              <p>{comment.body}</p>
            </div>
          ))}
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
            run(async () => {
              const next = await liveApi.threads.query({
                artifactId,
                cursor: threads.next,
                limit: 100,
              });
              setThreads((old) => ({
                items: [...old.items, ...next.items],
                next: next.next,
              }));
            })
          }
          type="button"
        >
          More comments
        </button>
      )}
    </aside>
  );
}
