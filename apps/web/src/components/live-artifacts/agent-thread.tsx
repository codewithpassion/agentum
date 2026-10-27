/** biome-ignore-all lint/performance/noJsxPropsBind: Panel actions capture current form values. */
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { ThreadEvent } from "@repo/protocol/thread";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionEvents } from "#/components/task/use-session-events";
import { ThreadContainer } from "#/components/thread/thread-container";
import {
  type ThreadEnv,
  ThreadEnvProvider,
} from "#/components/thread/thread-context";
import {
  applyThreadFrame,
  initialThread,
  resetThread,
} from "#/components/thread/thread-state";
import { useTaskThreadRuntime } from "#/components/thread/use-task-thread-runtime";
import { getTrpc } from "#/integrations/trpc/client";
import { ToolButton } from "./editor-toolbar";
import { liveApi } from "./live-api";

export function AgentTranscript({
  sessionId,
  agentName,
}: {
  sessionId: string;
  agentName: string;
}) {
  const [thread, setThread] = useState(() => initialThread([]));
  const [error, setError] = useState<string>();
  const last = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const result = await getTrpc().sessions.transcript.query({ sessionId });
      const events: ThreadEvent[] = result.entries;
      last.current = events.at(-1)?.id ?? null;
      setThread((old) => resetThread(old, events));
      setError(undefined);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not load transcript"
      );
    }
  }, [sessionId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const { mode } = useSessionEvents({
    lastEventId: () => last.current,
    onFrame: (frame) => {
      if (frame.frame === "event") {
        last.current = frame.id;
      }
      setThread((old) => applyThreadFrame(old, frame));
    },
    refetch: refresh,
    sessionId,
  });
  const readOnly = useCallback(
    () => Promise.reject(new Error("Use the artifact agent composer below.")),
    []
  );
  const report = useCallback(
    (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Thread action failed"),
    []
  );
  const runtime = useTaskThreadRuntime({
    messages: thread.messages,
    multiPerson: true,
    onEdit: readOnly,
    onError: report,
    onSend: readOnly,
  });
  const env = useMemo<ThreadEnv>(
    () => ({
      agentName,
      answer: () =>
        Promise.reject(new Error("Open the run to answer this request")),
      editableId: null,
      edited: new Set(),
      files: new Map(),
      nowMs: null,
      requests: new Map(),
    }),
    [agentName]
  );
  return (
    <section aria-label="Shared agent transcript">
      {Boolean(error) && (
        <p role="alert">
          {error} <ToolButton onClick={refresh}>Retry transcript</ToolButton>
        </p>
      )}
      {mode === "poll" && (
        <p role="status">Live stream unavailable; refreshing transcript.</p>
      )}
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadEnvProvider value={env}>
          <ThreadContainer composer={null} />
        </ThreadEnvProvider>
      </AssistantRuntimeProvider>
      {thread.messages
        .filter(
          (message) => message.role === "assistant" && message.runId !== null
        )
        .slice(-1)
        .map((message) => (
          <a
            href={`/tasks/${encodeURIComponent(message.runId ?? "")}`}
            key={message.id}
          >
            Open run and approvals
          </a>
        ))}
    </section>
  );
}

export function AgentComposer({
  artifactId,
  canAsk,
  selection,
  onSent,
  beforeSend,
}: {
  artifactId: string;
  canAsk: boolean;
  selection?: string;
  onSent: () => Promise<void>;
  beforeSend?: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (busy || !text.trim()) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await beforeSend?.();
      await liveApi.ask.mutate({
        artifactId,
        text,
        via: selection ? "ask_agent" : "artifact_thread",
      });
      setText("");
      await onSent();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not ask agent");
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
      {Boolean(selection) && (
        <blockquote aria-label="Selected text">{selection}</blockquote>
      )}
      <label>
        Ask the agent
        <textarea
          aria-label="Ask the agent"
          disabled={!canAsk || busy}
          maxLength={16_000}
          onChange={(event) => setText(event.target.value)}
          value={text}
        />
      </label>
      <ToolButton disabled={!canAsk || busy || !text.trim()} onClick={submit}>
        {busy ? "Sending…" : "Send to agent"}
      </ToolButton>
      {!canAsk && <p>Your role allows reading this thread.</p>}
      {Boolean(error) && <p role="alert">{error}</p>}
    </form>
  );
}
