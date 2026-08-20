import { useCallback, useEffect, useRef } from "react";
import { Button } from "#/components/ui/button";
import type { Agent, MessageView } from "#/lib/api";
import { authorOf, groupKeyOf, type Viewer } from "#/lib/authors";
import { MessageItem } from "./message-item";

/** Consecutive messages from one author within this window share a header. */
const GROUPING_WINDOW_MS = 5 * 60 * 1000;

const startsGroup = (
  message: MessageView,
  previous: MessageView | undefined
): boolean =>
  !previous ||
  groupKeyOf(previous) !== groupKeyOf(message) ||
  message.createdAt - previous.createdAt > GROUPING_WINDOW_MS;

export function MessageStream({
  agentsById,
  messages,
  nextCursor,
  onLoadOlder,
  onOpenThread,
  onSelectAgent,
  viewer,
}: {
  agentsById: Map<string, Agent>;
  messages: MessageView[];
  nextCursor: string | null;
  onLoadOlder: () => Promise<void>;
  onOpenThread: (message: MessageView) => void;
  onSelectAgent: (agentId: string) => void;
  viewer: Viewer;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (messages.length > 0) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages]);

  const loadOlder = useCallback(() => {
    onLoadOlder();
  }, [onLoadOlder]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      {nextCursor ? (
        <div className="mb-4 flex justify-center">
          <Button onClick={loadOlder} size="sm" variant="ghost">
            Load older messages
          </Button>
        </div>
      ) : null}

      {messages.length === 0 ? (
        <p className="mt-10 text-center text-[var(--ws-muted)] text-sm">
          No messages yet. Say something to get started.
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        {messages.map((message, index) => (
          <MessageItem
            author={authorOf(message, agentsById, viewer)}
            key={message.id}
            message={message}
            onOpenThread={onOpenThread}
            onSelectAgent={onSelectAgent}
            showAuthor={startsGroup(message, messages[index - 1])}
          />
        ))}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
