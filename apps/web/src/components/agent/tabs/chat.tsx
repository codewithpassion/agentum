import { MAX_FILE_BYTES } from "@repo/db/shared";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";
import { Label } from "#/components/ui/label.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { FileInfo, SessionTranscript } from "#/integrations/trpc/types";
import type { AgentTab, AgentTabProps } from "../agent-tabs.ts";
import {
  canRetry,
  collectFileIds,
  fileIdsOfRun,
  isRunActive,
  MAX_ATTACHMENTS,
  POLL_MS,
  shouldPoll,
  statusLine,
  toChatItems,
} from "../chat/chat-logic.ts";
import { FileChips } from "../chat/file-chips.tsx";
import { TranscriptView } from "../chat/transcript-view.tsx";
import { uploadFile } from "../chat/upload-file.ts";
import { useFileInfos } from "../chat/use-file-infos.ts";

const CLOCK_MS = 15_000;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Uploads files one after another. Resolves with the first failure, or null. */
const uploadInOrder = (
  picked: File[],
  onUploaded: (info: FileInfo) => void
): Promise<string | null> =>
  picked.reduce<Promise<string | null>>(
    (previous, file) =>
      previous.then(async (failure) => {
        try {
          onUploaded(await uploadFile(file));
          return failure;
        } catch (cause) {
          return failure ?? messageOf(cause);
        }
      }),
    Promise.resolve(null)
  );

type LatestRun = NonNullable<SessionTranscript["latestRun"]>;

function StatusRow({
  run,
  nowMs,
  sending,
  onRetry,
}: {
  run: LatestRun;
  nowMs: number;
  sending: boolean;
  onRetry: () => void;
}) {
  const status = statusLine(run);
  const retryable = run.status === "interrupted";
  const allowed = canRetry(run, nowMs);
  return (
    <div className="flex flex-wrap items-center gap-3">
      {status === null ? null : (
        <p className="text-muted-foreground text-sm" role="status">
          {status}
        </p>
      )}
      {retryable ? (
        <Button
          disabled={!allowed || sending}
          onClick={onRetry}
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

function ChatView({ agent, openSession, sessionId }: AgentTabProps) {
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const latestRun = transcript?.latestRun ?? null;
  const items = useMemo(
    () => toChatItems(transcript?.entries ?? []),
    [transcript]
  );
  const shownFileIds = useMemo(
    () => collectFileIds(items, latestRun?.outputFileIds ?? []),
    [items, latestRun]
  );
  const { files, remember } = useFileInfos(shownFileIds);
  const readOnly = transcript !== null && transcript.session.origin !== "ui";
  const running = latestRun !== null && isRunActive(latestRun.status);
  // A new message waits for an interrupted run's process to end, like Retry.
  const blocked =
    running ||
    (sessionId !== undefined && transcript === null) ||
    (latestRun?.status === "interrupted" && !canRetry(latestRun, nowMs));
  const sendDisabled = sending || uploading || input.trim() === "" || blocked;
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
    (text: string, fileIds: string[]) => {
      const externalKey =
        sessionId === undefined
          ? undefined
          : (transcript?.session.externalKey ?? sessionId);
      return getTrpc().runs.start.mutate({
        agentId: agent.id,
        input: { fileIds, text },
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
    const sent = attachments;
    setInput("");
    setSending(true);
    setError(null);
    try {
      const result = await startRun(text, sent);
      setAttachments((current) => current.filter((id) => !sent.includes(id)));
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
  }, [attachments, input, load, openSession, sessionId, startRun]);

  const retry = useCallback(async () => {
    if (latestRun === null || transcript === null) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await startRun(
        latestRun.inputText,
        fileIdsOfRun(transcript.entries, latestRun.id)
      );
      await load();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSending(false);
    }
  }, [latestRun, load, startRun, transcript]);

  // The first failure is shown; the files that did upload stay attached.
  const attachFiles = useCallback(
    (picked: File[]) => {
      const room = Math.max(MAX_ATTACHMENTS - attachments.length, 0);
      const withinCount = picked.slice(0, room);
      const accepted = withinCount.filter(
        (file) => file.size <= MAX_FILE_BYTES
      );
      let excess: string | null = null;
      if (picked.length > withinCount.length) {
        excess = `You can attach up to ${MAX_ATTACHMENTS} files.`;
      } else if (accepted.length < withinCount.length) {
        excess = "Files are limited to 50 MB.";
      }
      setUploading(true);
      setError(null);
      uploadInOrder(accepted, (info) => {
        remember([info]);
        setAttachments((current) => [...current, info.id]);
      }).then((failure) => {
        setUploading(false);
        setError(excess ?? failure);
      });
    },
    [attachments.length, remember]
  );

  const openPicker = useCallback(() => fileInputRef.current?.click(), []);

  const handleFiles = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(event.target.files ?? []);
      // Clear the value so picking the same file again fires a change.
      event.target.value = "";
      if (picked.length > 0) {
        attachFiles(picked);
      }
    },
    [attachFiles]
  );

  const removeAttachment = useCallback(
    (id: string) =>
      setAttachments((current) => current.filter((item) => item !== id)),
    []
  );

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

  let outputFiles: ReactNode = null;
  if (latestRun !== null && latestRun.outputFileIds.length > 0) {
    outputFiles = (
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-sm">Files from the agent</p>
        <FileChips fileIds={latestRun.outputFileIds} files={files} />
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
        <FileChips
          fileIds={attachments}
          files={files}
          onRemove={removeAttachment}
        />
        {uploading ? (
          <p className="text-muted-foreground text-sm">Uploading...</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Attach files"
            className="sr-only"
            multiple
            onChange={handleFiles}
            ref={fileInputRef}
            type="file"
          />
          <Button
            disabled={uploading}
            onClick={openPicker}
            type="button"
            variant="outline"
          >
            Attach files
          </Button>
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
      <TranscriptView files={files} items={items} />
      {outputFiles}
      {latestRun === null ? null : (
        <StatusRow
          nowMs={nowMs}
          onRetry={retry}
          run={latestRun}
          sending={sending}
        />
      )}
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
