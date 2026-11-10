import { Link } from "@tanstack/react-router";
import { useCallback } from "react";
import { ConversationList } from "#/components/conversations/conversation-list.tsx";
import {
  fromThread,
  threadHref,
} from "#/components/conversations/conversation-logic.ts";
import { MainThreadButton } from "#/components/conversations/use-main-thread.tsx";
import { NewTaskDialog } from "#/components/desk/new-task-dialog.tsx";
import { useGo } from "#/components/rail/rail-link.tsx";
import type { SessionListItem } from "#/integrations/trpc/types";

/** The agent's latest threads, with its main thread and a new conversation beside them. */
export function ThreadsCard({
  agent,
  archived,
  threads,
}: {
  agent: { id: string; name: string };
  archived: boolean;
  threads: readonly SessionListItem[];
}) {
  const go = useGo();
  const agents = [agent];
  const items = threads.map((thread) => fromThread(thread, agent.name));
  const handleStarted = useCallback(
    (_runId: string, sessionId: string) => go(threadHref(sessionId)),
    [go]
  );
  return (
    <section
      aria-label="Conversations"
      className="min-w-0 rounded-lg border border-border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <h2 className="font-semibold text-sm">Conversations</h2>
        {archived ? null : (
          <div className="flex gap-2">
            <MainThreadButton agentId={agent.id}>
              Open main thread
            </MainThreadButton>
            <NewTaskDialog
              agents={agents}
              onStarted={handleStarted}
              triggerLabel="New conversation"
            />
          </div>
        )}
      </div>
      <div className="max-h-96 overflow-y-auto border-border border-t">
        <ConversationList
          emptyText="No conversations yet."
          items={items}
          label={`${agent.name} conversations`}
        />
      </div>
      <div className="border-border border-t px-4 py-2.5">
        <Link
          className="pointer-coarse:inline-flex pointer-coarse:min-h-10 pointer-coarse:items-center text-sm underline-offset-4 hover:underline"
          search={{ agent: agent.id }}
          to="/sessions"
        >
          All conversations
        </Link>
      </div>
    </section>
  );
}
