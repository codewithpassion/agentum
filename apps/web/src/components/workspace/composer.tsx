import { useCallback, useId, useRef, useState } from "react";
import { Avatar } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import { Popover } from "#/components/ui/popover";
import { type Agent, type AttachmentView, uploadAttachment } from "#/lib/api";
import { formatBytes } from "#/lib/format";
import {
  applyMention,
  type MentionQuery,
  matchMentionCandidates,
  mentionQueryAt,
} from "#/lib/mention-input";

const MAX_SUGGESTIONS = 6;

function MentionOption({
  agent,
  onPick,
}: {
  agent: Agent;
  onPick: (agent: Agent) => void;
}) {
  const pick = useCallback(() => onPick(agent), [agent, onPick]);
  return (
    <button
      className="ws-focus flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-[var(--ws-surface-hover)]"
      onClick={pick}
      type="button"
    >
      <Avatar color={agent.avatar} name={agent.name} size="sm" />
      {agent.name}
    </button>
  );
}

function PendingChip({
  attachment,
  onRemove,
}: {
  attachment: AttachmentView;
  onRemove: (id: string) => void;
}) {
  const remove = useCallback(
    () => onRemove(attachment.id),
    [attachment.id, onRemove]
  );
  return (
    <li className="flex items-center gap-2 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-2 py-1 text-xs">
      <span>{attachment.filename}</span>
      <span className="text-[var(--ws-muted)]">
        {formatBytes(attachment.size)}
      </span>
      <button
        aria-label={`Remove ${attachment.filename}`}
        className="ws-focus rounded text-[var(--ws-muted)] hover:text-[var(--ws-text)]"
        onClick={remove}
        type="button"
      >
        ✕
      </button>
    </li>
  );
}

export function Composer({
  agents,
  onSend,
  placeholder,
}: {
  agents: Agent[];
  onSend: (input: { attachmentIds: string[]; body: string }) => Promise<void>;
  placeholder: string;
}) {
  const inputId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [body, setBody] = useState("");
  const [pending, setPending] = useState<AttachmentView[]>([]);
  const [mention, setMention] = useState<MentionQuery | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestions = mention
    ? matchMentionCandidates(agents, mention.query).slice(0, MAX_SUGGESTIONS)
    : [];

  const syncMention = useCallback((element: HTMLTextAreaElement) => {
    setMention(mentionQueryAt(element.value, element.selectionStart));
  }, []);

  const closeMention = useCallback(() => setMention(undefined), []);

  const pickMention = useCallback(
    (agent: Agent) => {
      const element = textareaRef.current;
      // biome-ignore lint/suspicious/noUnnecessaryConditions: the ref is null before the textarea mounts
      if (!(element && mention)) {
        return;
      }
      const next = applyMention(
        element.value,
        mention,
        element.selectionStart,
        agent.name
      );
      setBody(next.text);
      setMention(undefined);
      requestAnimationFrame(() => {
        element.focus();
        element.setSelectionRange(next.caret, next.caret);
      });
    },
    [mention]
  );

  const send = useCallback(async () => {
    const trimmed = body.trim();
    if (busy || (trimmed.length === 0 && pending.length === 0)) {
      return;
    }
    setBusy(true);
    try {
      await onSend({
        attachmentIds: pending.map((attachment) => attachment.id),
        body: trimmed,
      });
      setBody("");
      setPending([]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to send.");
    } finally {
      setBusy(false);
    }
  }, [body, busy, onSend, pending]);

  const submit = useCallback(() => {
    send();
  }, [send]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const [first] = suggestions;
      if (first && event.key === "Tab") {
        event.preventDefault();
        pickMention(first);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    },
    [pickMention, send, suggestions]
  );

  const onTextChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setBody(event.target.value);
      syncMention(event.target);
    },
    [syncMention]
  );

  const onCaretMove = useCallback(
    (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
      syncMention(event.currentTarget);
    },
    [syncMention]
  );

  const removePending = useCallback((id: string) => {
    setPending((previous) => previous.filter((entry) => entry.id !== id));
  }, []);

  const attachFiles = useCallback(async (files: FileList) => {
    setBusy(true);
    try {
      const uploaded = await Promise.all([...files].map(uploadAttachment));
      setPending((previous) => [...previous, ...uploaded]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }, []);

  const onFilesPicked = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const { files } = event.target;
      if (files && files.length > 0) {
        attachFiles(files);
      }
      event.target.value = "";
    },
    [attachFiles]
  );

  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);

  return (
    <div className="relative border-[var(--ws-line)] border-t bg-[var(--ws-panel)] px-4 py-3">
      <Popover
        className="bottom-full mb-2 w-64"
        onClose={closeMention}
        open={suggestions.length > 0}
      >
        <p className="px-2 py-1 text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
          Mention an agent
        </p>
        {suggestions.map((agent) => (
          <MentionOption agent={agent} key={agent.id} onPick={pickMention} />
        ))}
      </Popover>

      {pending.length > 0 ? (
        <ul className="m-0 mb-2 flex list-none flex-wrap gap-2 p-0">
          {pending.map((attachment) => (
            <PendingChip
              attachment={attachment}
              key={attachment.id}
              onRemove={removePending}
            />
          ))}
        </ul>
      ) : null}

      {error ? (
        <p className="mb-2 text-[var(--ws-danger)] text-xs">{error}</p>
      ) : null}

      <div className="flex items-end gap-2">
        <input
          className="hidden"
          multiple
          onChange={onFilesPicked}
          ref={fileInputRef}
          type="file"
        />
        <Button
          aria-label="Attach a file"
          disabled={busy}
          onClick={openFilePicker}
          size="icon"
          title="Attach a file"
          variant="subtle"
        >
          <span aria-hidden="true">＋</span>
        </Button>

        <label className="sr-only" htmlFor={inputId}>
          Message
        </label>
        <textarea
          className="ws-focus max-h-40 min-h-9 flex-1 resize-none rounded-xl border border-[var(--ws-line)] bg-[var(--ws-surface)] px-3 py-2 text-[var(--ws-text)] text-sm placeholder:text-[var(--ws-muted)]"
          id={inputId}
          onChange={onTextChange}
          onClick={onCaretMove}
          onKeyDown={onKeyDown}
          onKeyUp={onCaretMove}
          placeholder={placeholder}
          ref={textareaRef}
          rows={1}
          value={body}
        />

        <Button disabled={busy} onClick={submit} size="md" variant="primary">
          Send
        </Button>
      </div>
      <p className="mt-1.5 text-[10px] text-[var(--ws-muted)]">
        Markdown supported · Enter sends · Shift+Enter adds a line · @ mentions
        an agent
      </p>
    </div>
  );
}
