import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collectFileIds,
  POLL_MS,
  shouldPoll,
  statusLine,
  toChatItems,
} from "#/components/agent/chat/chat-logic.ts";
import { TranscriptView } from "#/components/agent/chat/transcript-view.tsx";
import {
  originLabel,
  sessionTitle,
} from "#/components/sessions/sessions-logic.ts";
import { useFileInfos } from "#/components/thread/use-file-infos.ts";
import { getTrpc } from "#/integrations/trpc/client";
import type { SessionTranscript } from "#/integrations/trpc/types";

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** A read-only view of one session's transcript, kept fresh while a run is active. */
export function SessionTranscriptPanel({
  agentNames,
  sessionId,
}: {
  agentNames: ReadonlyMap<string, string>;
  sessionId: string;
}) {
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The session this panel shows. Null after unmount, so a late response is dropped.
  const shownId = useRef<string | null>(null);

  const latestRun = transcript?.latestRun ?? null;
  const items = useMemo(
    () => toChatItems(transcript?.entries ?? [], transcript?.outputFileIds),
    [transcript]
  );
  const shownFileIds = useMemo(() => collectFileIds(items), [items]);
  const { files } = useFileInfos(shownFileIds);
  const polling = shouldPoll(latestRun, Date.now());

  useEffect(() => {
    shownId.current = sessionId;
    return () => {
      shownId.current = null;
    };
  }, [sessionId]);

  const load = useCallback(async () => {
    try {
      const next = await getTrpc().sessions.transcript.query({ sessionId });
      if (shownId.current !== sessionId) {
        return;
      }
      setTranscript(next);
      setError(null);
    } catch (cause) {
      if (shownId.current === sessionId) {
        setError(messageOf(cause));
      }
    }
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!polling) {
      return;
    }
    const id = setInterval(() => {
      load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [load, polling]);

  return (
    <section className="flex flex-col gap-4">
      {transcript === null ? null : (
        <div className="flex flex-col gap-1">
          <h2 className="font-medium text-foreground text-lg">
            {sessionTitle({
              agentName: agentNames.get(transcript.session.agentId) ?? "Agent",
              createdAt: transcript.session.createdAt,
              title: transcript.session.title,
            })}
          </h2>
          <p className="text-muted-foreground text-sm">
            {originLabel(transcript.session)}
          </p>
          {latestRun === null ? null : (
            <p className="text-muted-foreground text-sm" role="status">
              {statusLine(latestRun, transcript.queue)}
            </p>
          )}
        </div>
      )}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {transcript === null && error === null ? (
        <p className="text-muted-foreground text-sm">Loading...</p>
      ) : null}
      {transcript === null ? null : (
        <TranscriptView
          empty="This session has no messages."
          files={files}
          items={items}
        />
      )}
    </section>
  );
}
