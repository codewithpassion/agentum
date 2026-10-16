import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import type { InboxThread } from "#/integrations/trpc/types";
import { cn } from "#/lib/utils.ts";

interface ThreadListProps {
  activeId: string | undefined;
  threads: readonly InboxThread[];
}

export function ThreadList({ activeId, threads }: ThreadListProps) {
  if (threads.length === 0) {
    return <p className="text-muted-foreground text-sm">No threads yet.</p>;
  }
  return (
    <nav aria-label="Threads">
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
                search={{ thread: thread.id }}
                to="/inbox"
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
