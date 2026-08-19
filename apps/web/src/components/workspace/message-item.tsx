import { useCallback } from "react";
import { Avatar } from "#/components/ui/avatar";
import type { MessageView } from "#/lib/api";
import type { AuthorInfo } from "#/lib/authors";
import { cx } from "#/lib/cx";
import { formatTime } from "#/lib/format";
import { AttachmentList } from "./attachments";
import { Markdown } from "./markdown";

function AuthorChip({
  author,
  onSelectAgent,
  timestamp,
}: {
  author: AuthorInfo;
  onSelectAgent: (agentId: string) => void;
  timestamp: number;
}) {
  const { agentId } = author;
  const selectAgent = useCallback(() => {
    if (agentId) {
      onSelectAgent(agentId);
    }
  }, [agentId, onSelectAgent]);

  const avatar = author.imageUrl ? (
    <img
      alt=""
      className="h-6 w-6 rounded-full"
      height={24}
      src={author.imageUrl}
      width={24}
    />
  ) : (
    <Avatar color={author.color} name={author.name} size="sm" />
  );
  const name = (
    <span className="font-semibold text-[var(--ws-text)] text-xs">
      {author.name}
    </span>
  );

  return (
    <div className="mb-1 flex items-center gap-2">
      {agentId ? (
        <button
          className="ws-focus flex items-center gap-2 rounded-full"
          onClick={selectAgent}
          title={`Open ${author.name}'s profile`}
          type="button"
        >
          {avatar}
          {name}
        </button>
      ) : (
        <>
          {avatar}
          {name}
        </>
      )}
      <time className="text-[10px] text-[var(--ws-muted)]">
        {formatTime(timestamp)}
      </time>
    </div>
  );
}

export function MessageItem({
  author,
  message,
  onOpenThread,
  onSelectAgent,
  showAuthor,
}: {
  author: AuthorInfo;
  message: MessageView;
  /** Omitted inside the thread panel, where replies have no thread of their own. */
  onOpenThread?: (message: MessageView) => void;
  onSelectAgent: (agentId: string) => void;
  showAuthor: boolean;
}) {
  const openThread = useCallback(
    () => onOpenThread?.(message),
    [message, onOpenThread]
  );
  const replyLabel =
    message.replyCount > 0
      ? `${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}`
      : "Reply";

  return (
    <article
      className={cx(
        "flex flex-col",
        author.isSelf ? "items-end" : "items-start"
      )}
    >
      {showAuthor ? (
        <AuthorChip
          author={author}
          onSelectAgent={onSelectAgent}
          timestamp={message.createdAt}
        />
      ) : null}

      <div
        className={cx(
          "max-w-[min(680px,80%)] rounded-2xl px-3.5 py-2.5",
          author.isSelf
            ? "ws-own bg-[var(--ws-accent)] text-[var(--ws-accent-ink)]"
            : "bg-[var(--ws-surface)] text-[var(--ws-text)]"
        )}
      >
        <Markdown body={message.body} />
        <AttachmentList attachments={message.attachments} />
      </div>

      {onOpenThread ? (
        <button
          className="ws-focus mt-1 rounded px-1 text-[11px] text-[var(--ws-muted)] hover:text-[var(--ws-text)]"
          onClick={openThread}
          type="button"
        >
          {replyLabel}
        </button>
      ) : null}
    </article>
  );
}
