import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { type ReactNode, useMemo } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import type { SessionListItem } from "#/integrations/trpc/types";
import {
  lastActivity,
  originLabel,
  sessionTitle,
  statusLabel,
} from "./sessions-logic.ts";

interface SessionListProps {
  agentNames: ReadonlyMap<string, string>;
  sessions: readonly SessionListItem[];
}

interface SessionItemProps {
  agentName: string;
  session: SessionListItem;
}

interface TaskLinkProps {
  children: ReactNode;
  runId: string;
}

const itemClass = "flex flex-col gap-0.5 rounded-md px-3 py-2";

function TaskLink({ children, runId }: TaskLinkProps) {
  const params = useMemo(() => ({ runId }), [runId]);
  return (
    <Link
      className={`${itemClass} hover:bg-accent`}
      params={params}
      to="/tasks/$runId"
    >
      {children}
    </Link>
  );
}

function SessionItem({ agentName, session }: SessionItemProps) {
  const activity = lastActivity(session);
  const content = (
    <>
      <span className="truncate font-medium text-sm">
        {sessionTitle({
          agentName,
          createdAt: session.createdAt,
          title: session.title,
        })}
      </span>
      <span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
        <span className="truncate">{agentName}</span>
        <span className="truncate">{originLabel(session)}</span>
        <Badge variant="secondary">{statusLabel(session.status)}</Badge>
      </span>
      {/* The relative time reads the clock, so the server and browser can differ by a bucket. */}
      <time
        className="text-muted-foreground text-xs"
        dateTime={activity}
        suppressHydrationWarning
      >
        {formatDistanceToNow(new Date(activity), { addSuffix: true })}
      </time>
    </>
  );
  const runId = session.latestRunId;
  return (
    <li>
      {runId === null ? (
        <div className={`${itemClass} text-muted-foreground`}>{content}</div>
      ) : (
        <TaskLink runId={runId}>{content}</TaskLink>
      )}
    </li>
  );
}

export function SessionList({ agentNames, sessions }: SessionListProps) {
  if (sessions.length === 0) {
    return <p className="text-muted-foreground text-sm">No sessions.</p>;
  }
  return (
    <nav aria-label="Sessions">
      <ul className="flex flex-col gap-1">
        {sessions.map((session) => (
          <SessionItem
            agentName={agentNames.get(session.agentId) ?? "Agent"}
            key={session.id}
            session={session}
          />
        ))}
      </ul>
    </nav>
  );
}
