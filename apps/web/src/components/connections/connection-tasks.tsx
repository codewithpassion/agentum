import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "#/components/ui/badge";
import { buttonVariants } from "#/components/ui/button";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { clipMessage, taskStateWords } from "./connections-logic.ts";

type Task = RouterOutputs["a2a"]["recentTasks"][number];

const DIRECTION_WORDS: Record<Task["direction"], string> = {
  in: "From the peer",
  out: "To the peer",
};

function TaskRow({ task }: { task: Task }) {
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-foreground">
          {DIRECTION_WORDS[task.direction]}
        </span>
        <Badge variant="outline">{taskStateWords(task.state)}</Badge>
        <span className="text-muted-foreground">
          {formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })}
        </span>
      </div>
      <p className="whitespace-pre-wrap break-words text-foreground text-sm">
        {clipMessage(task.text)}
      </p>
      {task.statusText === null ? null : (
        <p className="text-muted-foreground text-sm">{task.statusText}</p>
      )}
      {task.decidedBy === null ? null : (
        <p className="text-muted-foreground text-sm">
          Decided by {task.decidedBy}
        </p>
      )}
      {task.runId === null ? null : (
        <Link
          className={buttonVariants({
            className: "self-start px-0",
            size: "sm",
            variant: "link",
          })}
          params={{ runId: task.runId }}
          to="/tasks/$runId"
        >
          Open run
        </Link>
      )}
    </li>
  );
}

export function ConnectionTasks({
  tasks,
}: {
  tasks: RouterOutputs["a2a"]["recentTasks"];
}) {
  if (tasks.length === 0) {
    return <p className="text-muted-foreground text-sm">No messages yet.</p>;
  }
  return (
    <ul className="flex flex-col divide-y">
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </ul>
  );
}
