import type { RunStatus } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { statusPill } from "./task-logic.ts";

export interface ThreadRun {
  createdAt: string;
  id: string;
  status: RunStatus;
  title: string;
}

export const sessionRuns = (
  others: readonly ThreadRun[],
  current: ThreadRun
): ThreadRun[] =>
  [...others.filter((run) => run.id !== current.id), current].sort((a, b) =>
    a.id.localeCompare(b.id)
  );

export function earlierRunsLabel(runs: readonly ThreadRun[]): string {
  const uniform =
    runs.length > 0 && runs.every((run) => run.status === runs[0]?.status);
  const suffix =
    uniform && (runs[0]?.status === "done" || runs[0]?.status === "failed")
      ? ` · all ${runs[0].status}`
      : "";
  return `${runs.length} earlier runs in this thread${suffix}`;
}

export const runPickerStatus = (status: RunStatus): string =>
  status === "waiting" ? "Needs you" : statusPill(status).text;

/** Radix supplies menu focus, arrow keys and Escape returning to the picker. */
export function RunPicker({
  runs,
  runId,
}: {
  runs: readonly ThreadRun[];
  runId: string;
}) {
  if (runs.length < 2) {
    return null;
  }
  const number = runs.findIndex((run) => run.id === runId) + 1;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Run ${number} of ${runs.length}`}
          className="h-10 shrink-0 md:h-7"
          size="sm"
          variant="outline"
        >
          <span className="md:hidden">
            {number}/{runs.length}
          </span>
          <span className="hidden md:inline">
            Run {number} of {runs.length}
          </span>{" "}
          ▾
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-80 w-[min(440px,calc(100vw-24px))]"
      >
        {runs.map((run, index) => (
          <DropdownMenuItem asChild key={run.id}>
            <Link
              aria-current={run.id === runId ? "page" : undefined}
              className="flex min-h-11 flex-wrap gap-x-2"
              params={{ runId: run.id }}
              to="/tasks/$runId"
            >
              <span>
                Run {index + 1} · {runPickerStatus(run.status)} ·{" "}
                {run.createdAt.slice(11, 16)}
              </span>
              <span className="w-full truncate text-muted-foreground">
                {run.title}
              </span>
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
