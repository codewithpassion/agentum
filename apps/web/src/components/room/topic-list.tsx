import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import type { InboxThread } from "#/integrations/trpc/types";
import { cn } from "#/lib/utils.ts";

interface TopicListProps {
  activeId: string | undefined;
  onPick?: () => void;
  teamId: string;
  threads: readonly InboxThread[];
}

export function TopicList({
  activeId,
  onPick,
  teamId,
  threads,
}: TopicListProps) {
  if (threads.length === 0) {
    return <p className="text-muted-foreground text-sm">No topics yet.</p>;
  }
  return (
    <nav aria-label="Topics">
      <ul className="flex flex-col gap-1">
        {threads.map((thread) => {
          const active = thread.id === activeId;
          return (
            <li key={thread.id}>
              <Link
                aria-current={active ? "true" : undefined}
                className={cn(
                  "flex flex-col gap-0.5 rounded-md px-3 py-2 hover:bg-accent",
                  active && "bg-accent"
                )}
                onClick={onPick}
                params={{ teamId }}
                search={{ topic: thread.id }}
                to="/teams/$teamId/room"
              >
                <span className="truncate font-medium text-sm">
                  {thread.title}
                </span>
                <time
                  className="text-muted-foreground text-xs"
                  dateTime={thread.lastPostAt}
                >
                  {formatDistanceToNow(new Date(thread.lastPostAt), {
                    addSuffix: true,
                  })}
                </time>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
