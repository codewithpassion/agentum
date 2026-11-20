import { Link } from "@tanstack/react-router";
import type { StepLine, TaskListItem } from "./now-logic.ts";
import { stepText } from "./now-logic.ts";

const STATE_DOTS: Record<StepLine["state"], string> = {
  done: "bg-success",
  failed: "bg-destructive",
  paused: "bg-warning",
  running: "bg-info",
};

/** What the agent is doing now: the running task's latest step as one line, with a link to the task. */
export function StepCard({
  run,
  step,
}: {
  /** The running task, or null when nothing is running. */
  run: Pick<TaskListItem, "id" | "title"> | null;
  /** The task's latest step, or null while it is still being read. */
  step: StepLine | null;
}) {
  return (
    <section
      aria-label="Right now"
      className="min-w-0 rounded-lg border border-border bg-card"
      data-testid="now-step-card"
    >
      <h2 className="px-4 py-3 font-semibold text-sm">Right now</h2>
      {run === null ? (
        <p className="px-4 pb-3 text-muted-foreground text-xs">
          Nothing is running.
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-1 px-4 pb-3">
          <p className="truncate font-medium text-sm">{run.title}</p>
          <p
            aria-live="polite"
            className="flex min-w-0 items-start gap-2 text-sm"
            data-testid="now-step"
          >
            <span
              aria-hidden="true"
              className={`mt-1.5 size-2 shrink-0 rounded-full ${step === null ? "bg-muted-foreground" : STATE_DOTS[step.state]}`}
            />
            <span className="line-clamp-2 min-w-0 break-words">
              {step === null ? "Starting." : stepText(step)}
            </span>
          </p>
          <Link
            className="pointer-coarse:inline-flex pointer-coarse:min-h-10 pointer-coarse:items-center text-sm underline-offset-4 hover:underline"
            params={{ runId: run.id }}
            to="/tasks/$runId"
          >
            Open task
          </Link>
        </div>
      )}
    </section>
  );
}
