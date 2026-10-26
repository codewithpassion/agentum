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
import { toast } from "sonner";
import { SendHint } from "#/components/composer/send-hint.tsx";
import { submitOnSendShortcut } from "#/components/composer/send-shortcut.ts";
import { Button } from "#/components/ui/button.tsx";
import { Label } from "#/components/ui/label.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { FileInfo, SessionTranscript } from "#/integrations/trpc/types";
import type { AgentTab, AgentTabProps } from "../agent-tabs.ts";
import {
  canCancel,
  canRetry,
  collectFileIds,
  fileIdsOfRun,
  isRunActive,
  MAX_ATTACHMENTS,
  statusLine,
} from "../chat/chat-logic.ts";
import { FileChips } from "../chat/file-chips.tsx";
import { LibraryPicker } from "../chat/library-picker.tsx";
import { TranscriptView } from "../chat/transcript-view.tsx";
import { uploadFile } from "../chat/upload-file.ts";
import { useFileInfos } from "../chat/use-file-infos.ts";
import { useSessionStream } from "../chat/use-session-stream.ts";

const CLOCK_MS = 15_000;
const BYTES_PER_MB = 1024 * 1024;

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
  queue,
  nowMs,
  sending,
  cancelling,
  onRetry,
  onCancel,
}: {
  run: LatestRun;
  queue: SessionTranscript["queue"];
  nowMs: number;
  sending: boolean;
  cancelling: boolean;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const status = statusLine(run, queue);
  const retryable = run.status === "interrupted";
  const allowed = canRetry(run, nowMs);
  return (
    <div className="flex flex-wrap items-center gap-3">
      {status === null ? null : (
        <p className="text-muted-foreground text-sm" role="status">
          {status}
        </p>
      )}
      {canCancel(run) ? (
        <Button
          disabled={cancelling}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
      ) : null}
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
  const {
    error: loadError,
    items,
    reload,
    transcript,
  } = useSessionStream(sessionId);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const latestRun = transcript?.latestRun ?? null;
  const shownFileIds = useMemo(() => collectFileIds(items), [items]);
  const { files, remember } = useFileInfos(shownFileIds);
  const readOnly = transcript !== null && transcript.session.origin !== "ui";
  const running = latestRun !== null && isRunActive(latestRun.status);
  // A new message waits for an interrupted run's process to end, like Retry.
  const blocked =
    running ||
    (sessionId !== undefined && transcript === null) ||
    (latestRun?.status === "interrupted" && !canRetry(latestRun, nowMs));
  const sendDisabled =
    sending || uploading || attaching || input.trim() === "" || blocked;

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
        await reload();
      }
    } catch (cause) {
      setInput((current) => current || text);
      setError(messageOf(cause));
    } finally {
      setSending(false);
    }
  }, [attachments, input, openSession, reload, sessionId, startRun]);

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
      await reload();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSending(false);
    }
  }, [latestRun, reload, startRun, transcript]);

  const cancel = useCallback(async () => {
    if (latestRun === null) {
      return;
    }
    setCancelling(true);
    try {
      await getTrpc().runs.cancel.mutate({ runId: latestRun.id });
      await reload();
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setCancelling(false);
    }
  }, [latestRun, reload]);

  // The first failure is shown; the files that did upload stay attached.
  const attachFiles = useCallback(
    (picked: File[]) => {
      const room = Math.max(MAX_ATTACHMENTS - attachments.length, 0);
      const withinCount = picked.slice(0, room);
      const accepted = withinCount.filter(
        (file) => file.size <= MAX_FILE_BYTES
      );
      const problems: string[] = [];
      if (picked.length > withinCount.length) {
        problems.push(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      }
      if (accepted.length < withinCount.length) {
        problems.push(
          `Files are limited to ${MAX_FILE_BYTES / BYTES_PER_MB} MB.`
        );
      }
      const excess = problems.length > 0 ? problems.join(" ") : null;
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

  const openLibrary = useCallback(() => setPickerOpen(true), []);

  const closeLibrary = useCallback(() => setPickerOpen(false), []);

  const attachFromLibrary = useCallback(
    async (path: string) => {
      setPickerOpen(false);
      if (attachments.length >= MAX_ATTACHMENTS) {
        setError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
        return;
      }
      setAttaching(true);
      setError(null);
      try {
        const info = await getTrpc().files.attachFromLibrary.mutate({ path });
        remember([info]);
        setAttachments((current) => [...current, info.id]);
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setAttaching(false);
      }
    },
    [attachments.length, remember]
  );

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
      if (sendDisabled) {
        return;
      }
      send();
    },
    [send, sendDisabled]
  );

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
        <Textarea
          aria-describedby="chat-send-hint"
          id="chat-message"
          onChange={handleInput}
          onKeyDown={submitOnSendShortcut}
          value={input}
        />
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
          <Button
            data-testid="library-picker-open"
            disabled={uploading || attaching}
            onClick={openLibrary}
            type="button"
            variant="outline"
          >
            From library
          </Button>
          <Button disabled={sendDisabled} type="submit">
            Send
          </Button>
          <SendHint id="chat-send-hint" />
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
      <TranscriptView agentName={agent.name} files={files} items={items} />
      {latestRun === null ? null : (
        <StatusRow
          cancelling={cancelling}
          nowMs={nowMs}
          onCancel={cancel}
          onRetry={retry}
          queue={transcript?.queue ?? null}
          run={latestRun}
          sending={sending}
        />
      )}
      {(error ?? loadError) ? (
        <p className="text-destructive text-sm" role="alert">
          {error ?? loadError}
        </p>
      ) : null}
      {composer}
      {pickerOpen ? (
        <LibraryPicker onClose={closeLibrary} onPick={attachFromLibrary} />
      ) : null}
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
