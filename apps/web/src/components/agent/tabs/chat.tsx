import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";
import { Label } from "#/components/ui/label.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { SessionTranscript } from "#/integrations/trpc/types";
import type { AgentTab, AgentTabProps } from "../agent-tabs.ts";
import {
  canRetry,
  isRunActive,
  POLL_MS,
  shouldPoll,
  statusLine,
  toChatItems,
} from "../chat/chat-logic.ts";
import { TranscriptView } from "../chat/transcript-view.tsx";

const CLOCK_MS = 15_000;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function ChatView({ agent, openSession, sessionId }: AgentTabProps) {
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const latestRun = transcript?.latestRun ?? null;
  const items = useMemo(
    () => toChatItems(transcript?.entries ?? []),
    [transcript]
  );
  const status = statusLine(latestRun);
  const readOnly = transcript !== null && transcript.session.origin !== "ui";
  const running = latestRun !== null && isRunActive(latestRun.status);
  // A new message waits for an interrupted run's process to end, like Retry.
  const blocked =
    running ||
    (sessionId !== undefined && transcript === null) ||
    (latestRun?.status === "interrupted" && !canRetry(latestRun, nowMs));
  const sendDisabled = sending || input.trim() === "" || blocked;
  const polling = shouldPoll(latestRun, nowMs);

  const load = useCallback(async () => {
    if (sessionId === undefined) {
      return;
    }
    try {
      setTranscript(await getTrpc().sessions.transcript.query({ sessionId }));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
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

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_MS);
    return () => clearInterval(id);
  }, []);

  const startRun = useCallback(
    (text: string) => {
      const externalKey =
        sessionId === undefined
          ? undefined
          : (transcript?.session.externalKey ?? sessionId);
      return getTrpc().runs.start.mutate({
        agentId: agent.id,
        input: { text },
        requestId: crypto.randomUUID(),
        session:
          externalKey === undefined
            ? { origin: "ui" }
            : { externalKey, origin: "ui" },
      });
    },
    [agent.id, sessionId, transcript]
  );

  const send = useCallback(async () => {
    const text = input.trim();
    setInput("");
    setSending(true);
    setError(null);
    try {
      const result = await startRun(text);
      if (sessionId === undefined) {
        openSession(result.sessionId);
      } else {
        await load();
      }
    } catch (cause) {
      setInput((current) => current || text);
      setError(messageOf(cause));
    } finally {
      setSending(false);
    }
  }, [input, load, openSession, sessionId, startRun]);

  const retry = useCallback(async () => {
    if (latestRun === null) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await startRun(latestRun.inputText);
      await load();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSending(false);
    }
  }, [latestRun, load, startRun]);

  const newChat = useCallback(() => openSession(undefined), [openSession]);

  const handleInput = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setInput(event.target.value),
    []
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      send();
    },
    [send]
  );

  let statusRow: ReactNode = null;
  if (latestRun !== null) {
    const retryable = latestRun.status === "interrupted";
    const allowed = canRetry(latestRun, nowMs);
    statusRow = (
      <div className="flex flex-wrap items-center gap-3">
        {status === null ? null : (
          <p className="text-muted-foreground text-sm" role="status">
            {status}
          </p>
        )}
        {retryable ? (
          <Button
            disabled={!allowed || sending}
            onClick={retry}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        ) : null}
        {retryable && !allowed ? (
          <p className="text-muted-foreground text-sm">
            Retry unlocks when the process has ended, or after 10 minutes.
          </p>
        ) : null}
      </div>
    );
  }

  let composer: ReactNode;
  if (readOnly) {
    composer = (
      <p className="text-muted-foreground text-sm">
        This session is read only here.
      </p>
    );
  } else {
    composer = (
      <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
        <Label htmlFor="chat-message">Message</Label>
        <Textarea id="chat-message" onChange={handleInput} value={input} />
        <div>
          <Button disabled={sendDisabled} type="submit">
            Send
          </Button>
        </div>
      </form>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      {sessionId === undefined ? null : (
        <div>
          <Button onClick={newChat} type="button" variant="outline">
            New chat
          </Button>
        </div>
      )}
      <TranscriptView items={items} />
      {statusRow}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {composer}
    </section>
  );
}

// Keyed by session, so a change of session starts from a fresh state: the old
// transcript is dropped, and a response for the old session is never applied.
function ChatPanel(props: AgentTabProps) {
  return <ChatView key={props.sessionId ?? ""} {...props} />;
}

export const chatTab: AgentTab = {
  id: "chat",
  label: "Chat",
  Panel: ChatPanel,
};
