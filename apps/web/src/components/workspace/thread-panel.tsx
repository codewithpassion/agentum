import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import type { Agent, MessageView } from "#/lib/api";
import { authorOf, type Viewer } from "#/lib/authors";
import type { Conversation } from "#/lib/use-conversation";
import { useApi } from "#/lib/workspace-context";
import { AgentActivity } from "./agent-activity";
import { Composer } from "./composer";
import { MessageItem } from "./message-item";

export function ThreadPanel({
  agents,
  agentsById,
  conversation,
  onClose,
  onSelectAgent,
  parentId,
  viewer,
}: {
  agents: Agent[];
  agentsById: Map<string, Agent>;
  conversation: Conversation;
  onClose: () => void;
  onSelectAgent: (agentId: string) => void;
  parentId: string;
  viewer: Viewer;
}) {
  const api = useApi();

  const [parent, setParent] = useState<MessageView | null>(null);
  const [replies, setReplies] = useState<MessageView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { applyQuestion, channel, mergeMessage, subscribeToReplies } =
    conversation;
  const { subscribeToQuestions } = conversation;
  const channelId = channel?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const thread = await api.getThread(parentId);
        if (!cancelled) {
          setParent(thread.parent);
          setReplies(thread.replies);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : "Failed to load thread."
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, parentId]);

  // Replies arrive on the channel socket, which the conversation owns.
  useEffect(
    () =>
      subscribeToReplies((message) => {
        if (message.threadParentId !== parentId) {
          return;
        }
        setReplies((previous) =>
          previous.some((entry) => entry.id === message.id)
            ? previous
            : [...previous, message]
        );
      }),
    [parentId, subscribeToReplies]
  );

  // The panel fetched its own copy of the parent, so a question resolved
  // anywhere - here, in the stream, on Slack - has to be replaced in it too.
  useEffect(
    () =>
      subscribeToQuestions((question) => {
        setParent((previous) =>
          previous && previous.id === question.messageId
            ? { ...previous, question }
            : previous
        );
      }),
    [subscribeToQuestions]
  );

  const send = useCallback(
    async (input: { attachmentIds: string[]; body: string }) => {
      if (!channelId) {
        return;
      }
      mergeMessage(
        await api.postMessage(channelId, { ...input, threadParentId: parentId })
      );
    },
    [api, channelId, mergeMessage, parentId]
  );

  return (
    <aside
      className="flex w-[22rem] shrink-0 flex-col border-[var(--ws-line)] border-l bg-[var(--ws-panel)]"
      data-testid="thread-panel"
    >
      <header className="flex items-center justify-between gap-2 border-[var(--ws-line)] border-b px-4 py-3">
        <h2 className="m-0 font-semibold text-sm">Thread</h2>
        <Button
          aria-label="Close thread"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <span aria-hidden="true">✕</span>
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {error ? (
          <p className="text-[var(--ws-danger)] text-xs">{error}</p>
        ) : null}
        <div className="flex flex-col gap-3">
          {parent ? (
            <MessageItem
              author={authorOf(parent, agentsById, viewer)}
              message={{ ...parent, replyCount: 0 }}
              onAnswerQuestion={applyQuestion}
              onSelectAgent={onSelectAgent}
              showAuthor
            />
          ) : null}
          {replies.length > 0 ? (
            <p className="m-0 text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
              {replies.length} {replies.length === 1 ? "reply" : "replies"}
            </p>
          ) : null}
          {replies.map((reply) => (
            <MessageItem
              author={authorOf(reply, agentsById, viewer)}
              key={reply.id}
              message={{ ...reply, replyCount: 0 }}
              onSelectAgent={onSelectAgent}
              showAuthor
            />
          ))}
        </div>
      </div>

      {/* The same channel-scoped statuses the main pane shows: a reply being
          written in a thread is the moment somebody is most obviously waiting
          for one. */}
      <AgentActivity
        statuses={conversation.agentStatuses}
        suppressed={conversation.suppressed}
      />
      <Composer agents={agents} onSend={send} placeholder="Reply in thread" />
    </aside>
  );
}
