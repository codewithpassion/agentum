import { Link } from "@tanstack/react-router";
import type { TaskView } from "#/integrations/trpc/types";
import { statusLabel } from "../sessions/sessions-logic.ts";

/**
 * Where a thread sits among the threads that started it and that it started:
 * a link back to its parent, and each child thread with its status. Nothing
 * for a thread with neither.
 */
export function ThreadRelatives({
  parent,
  subThreads,
}: {
  parent: TaskView["parent"];
  subThreads: TaskView["children"];
}) {
  if (parent === null && subThreads.length === 0) {
    return null;
  }
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b px-4 py-2 text-sm md:px-6">
      {parent === null ? null : (
        <p className="text-muted-foreground">
          Started from{" "}
          <Link
            className="text-foreground underline"
            params={{ sessionId: parent.id }}
            to="/threads/$sessionId"
          >
            {parent.title}
          </Link>
        </p>
      )}
      {subThreads.length === 0 ? null : (
        <ul aria-label="Sub-threads" className="space-y-0.5">
          {subThreads.map((child) => (
            <li className="flex items-center gap-2" key={child.id}>
              <Link
                className="truncate text-foreground underline"
                params={{ sessionId: child.id }}
                to="/threads/$sessionId"
              >
                {child.title}
              </Link>
              <span className="shrink-0 text-muted-foreground text-xs">
                {child.agentName}, {statusLabel(child.status)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
