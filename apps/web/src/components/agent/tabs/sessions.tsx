import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { sessionTitle } from "#/components/sessions/sessions-logic.ts";
import { Badge } from "#/components/ui/badge.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { SessionListItem } from "#/integrations/trpc/types";
import type { AgentTab, AgentTabProps } from "../agent-tabs.ts";

const rowClass =
  "flex w-full items-center justify-between gap-4 py-3 text-left";

function RunLink({ children, runId }: { children: ReactNode; runId: string }) {
  const params = useMemo(() => ({ runId }), [runId]);
  return (
    <Link
      className={`${rowClass} text-foreground hover:text-primary`}
      params={params}
      to="/tasks/$runId"
    >
      {children}
    </Link>
  );
}

function SessionRow({
  agentName,
  item,
}: {
  agentName: string;
  item: SessionListItem;
}) {
  const content = (
    <>
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
        <span>{formatDistanceToNow(item.createdAt, { addSuffix: true })}</span>
      </span>
    </>
  );

  return (
    <li>
      {item.latestRunId === null ? (
        <div className={`${rowClass} text-muted-foreground`}>{content}</div>
      ) : (
        <RunLink runId={item.latestRunId}>{content}</RunLink>
      )}
    </li>
  );
}

function SessionsPanel({ agent }: AgentTabProps) {
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
          <SessionRow agentName={agent.name} item={item} key={item.id} />
        ))}
      </ul>
    );
  }

  return <section className="flex flex-col gap-4">{body}</section>;
}

export const sessionsTab: AgentTab = {
  id: "sessions",
  label: "Sessions",
  Panel: SessionsPanel,
};
