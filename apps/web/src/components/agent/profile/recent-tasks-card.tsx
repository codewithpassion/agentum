import { Link } from "@tanstack/react-router";
import { elapsedText } from "#/components/desk/desk-logic.ts";
import { StatusBandLine } from "#/components/desk/status-band.tsx";
import type { RouterOutputs } from "#/integrations/trpc/types";

const SHOWN_TASKS = 5;

/** The agent's most recent tasks, each linking to its run, with a link to the desk filtered to the agent. */
export function RecentTasksCard({
  agentId,
  nowMs,
  tasks,
}: {
  agentId: string;
  nowMs: number | null;
  tasks: RouterOutputs["tasks"]["list"];
}) {
  const shown = tasks.slice(0, SHOWN_TASKS);
  return (
    <section
      aria-label="Recent tasks"
      className="min-w-0 rounded-lg border border-border bg-card"
    >
      <h2 className="px-4 py-3 font-semibold text-sm">Recent tasks</h2>
      {shown.length === 0 ? (
        <p className="px-4 pb-3 text-muted-foreground text-xs">No tasks yet.</p>
      ) : (
        <ul>
          {shown.map((task) => (
            <li className="border-border border-t" key={task.id}>
              <Link
                className="block px-4 pt-2.5 hover:bg-muted/50"
                params={{ runId: task.id }}
                to="/tasks/$runId"
              >
                <p className="truncate font-semibold text-sm">{task.title}</p>
                <p className="text-muted-foreground text-xs">
                  {nowMs === null ? "" : elapsedText(task.createdAt, nowMs)}
                </p>
              </Link>
              <StatusBandLine band={task.statusBand} />
            </li>
          ))}
        </ul>
      )}
      <div className="border-border border-t px-4 py-2.5">
        <Link
          className="text-sm underline-offset-4 hover:underline"
          search={{ agent: agentId }}
          to="/desk"
        >
          All tasks
        </Link>
      </div>
    </section>
  );
}
