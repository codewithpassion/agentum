import type { RunStatus } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { pillClass, statusPill } from "./task-logic.ts";

/** The other runs of a task's session, each a link to its own task view. */
export function ThreadRuns({
  heading,
  runs,
}: {
  heading: string;
  runs: {
    createdAt: string;
    id: string;
    inputText: string;
    status: RunStatus;
  }[];
}) {
  if (runs.length === 0) {
    return null;
  }
  return (
    <section aria-label={heading}>
      <h2 className="mb-1.5 text-muted-foreground text-xs uppercase tracking-wide">
        {heading}
      </h2>
      <ul className="flex flex-col gap-1">
        {runs.map((run) => {
          const pill = statusPill(run.status);
          return (
            <li key={run.id}>
              <Link
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm no-underline hover:bg-muted"
                data-testid="thread-run-link"
                params={{ runId: run.id }}
                to="/tasks/$runId"
              >
                <span className="min-w-0 flex-1 truncate">{run.inputText}</span>
                <span
                  className={`shrink-0 rounded-full px-2 py-px text-[11px] ${pillClass(pill.tone)}`}
                >
                  {pill.text}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
