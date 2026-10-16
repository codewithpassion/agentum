import { formatDistanceToNow } from "date-fns";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { sessionTitle } from "#/components/sessions/sessions-logic.ts";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { SessionListItem } from "#/integrations/trpc/types";
import type { AgentTab, AgentTabProps } from "../agent-tabs.ts";

function SessionRow({
  agentName,
  item,
  onOpen,
}: {
  agentName: string;
  item: SessionListItem;
  onOpen: (sessionId: string) => void;
}) {
  const open = useCallback(() => onOpen(item.id), [item.id, onOpen]);

  return (
    <li>
      <button
        className="flex w-full items-center justify-between gap-4 py-3 text-left text-foreground hover:text-primary"
        onClick={open}
        type="button"
      >
        <span className="min-w-0 truncate font-medium">
          {sessionTitle({
            agentName,
            createdAt: item.createdAt,
            title: item.title,
          })}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-muted-foreground text-sm">
          <span>{item.origin}</span>
          {item.status === null ? null : (
            <Badge variant="outline">{item.status}</Badge>
          )}
          <span>
            {formatDistanceToNow(item.createdAt, { addSuffix: true })}
          </span>
        </span>
      </button>
    </li>
  );
}

function SessionsPanel({ agent, openSession }: AgentTabProps) {
  const [sessions, setSessions] = useState<SessionListItem[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    getTrpc()
      .sessions.list.query({ agentId: agent.id })
      .then((items) => {
        if (active) {
          setSessions(items);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [agent.id]);

  const newChat = useCallback(() => openSession(undefined), [openSession]);

  let body: ReactNode;
  if (error !== undefined) {
    body = <p className="text-destructive text-sm">{error}</p>;
  } else if (sessions === undefined) {
    body = <p className="text-muted-foreground text-sm">Loading sessions.</p>;
  } else if (sessions.length === 0) {
    body = <p className="text-muted-foreground text-sm">No sessions yet.</p>;
  } else {
    body = (
      <ul className="divide-y divide-border border-border border-y">
        {sessions.map((item) => (
          <SessionRow
            agentName={agent.name}
            item={item}
            key={item.id}
            onOpen={openSession}
          />
        ))}
      </ul>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        <Button onClick={newChat} type="button">
          New chat
        </Button>
      </div>
      {body}
    </section>
  );
}

export const sessionsTab: AgentTab = {
  id: "sessions",
  label: "Sessions",
  Panel: SessionsPanel,
};
