import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { useCallback } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import type { SessionListItem } from "#/integrations/trpc/types";
import { cn } from "#/lib/utils.ts";
import { lastActivity, originLabel, statusLabel } from "./sessions-logic.ts";

interface SessionListProps {
  activeId: string | undefined;
  agentNames: ReadonlyMap<string, string>;
  sessions: readonly SessionListItem[];
}

interface SessionItemProps {
  active: boolean;
  agentName: string;
  session: SessionListItem;
}

function SessionItem({ active, agentName, session }: SessionItemProps) {
  const activity = lastActivity(session);
  const search = useCallback(
    (previous: Record<string, unknown>) => ({
      ...previous,
      session: session.id,
    }),
    [session.id]
  );
  return (
    <li>
      <Link
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex flex-col gap-0.5 rounded-md px-3 py-2 hover:bg-accent",
          active && "bg-accent"
        )}
        search={search}
        to="/sessions"
      >
        <span className="truncate font-medium text-sm">
          {session.title || "(no message)"}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
          <span className="truncate">{agentName}</span>
          <span className="truncate">{originLabel(session)}</span>
          <Badge variant="secondary">{statusLabel(session.status)}</Badge>
        </span>
        <time className="text-muted-foreground text-xs" dateTime={activity}>
          {formatDistanceToNow(new Date(activity), { addSuffix: true })}
        </time>
      </Link>
    </li>
  );
}

export function SessionList({
  activeId,
  agentNames,
  sessions,
}: SessionListProps) {
  if (sessions.length === 0) {
    return <p className="text-muted-foreground text-sm">No sessions.</p>;
  }
  return (
    <nav aria-label="Sessions">
      <ul className="flex flex-col gap-1">
        {sessions.map((session) => (
          <SessionItem
            active={session.id === activeId}
            agentName={agentNames.get(session.agentId) ?? "Agent"}
            key={session.id}
            session={session}
          />
        ))}
      </ul>
    </nav>
  );
}
