import type { RailWorking } from "@repo/db/shared";
import { useCallback, useState } from "react";
import { RailLink } from "./rail-link.tsx";

const VISIBLE_WORKING = 3;

const ROW_CLASS =
  "flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-muted-foreground text-sm no-underline hover:text-muted-foreground";

function WorkingRow({
  onNavigate,
  run,
}: {
  onNavigate: () => void;
  run: RailWorking;
}) {
  return (
    <RailLink
      className={`group/working ${ROW_CLASS}`}
      href={`/tasks/${encodeURIComponent(run.id)}`}
      onNavigate={onNavigate}
      title={run.status}
    >
      <span
        aria-hidden="true"
        className="size-[7px] shrink-0 animate-pulse rounded-full bg-muted-foreground/40 [animation-duration:1.8s] motion-reduce:animate-none"
      />
      <span className="truncate">
        {run.title}
        {run.passedOnBy === null ? "" : `, passed on by ${run.passedOnBy}`}
      </span>
      <span className="ml-auto hidden shrink-0 text-xs group-hover/working:inline group-focus-visible/working:inline">
        {run.status}
      </span>
    </RailLink>
  );
}

/** Pinned below the queue; compact windows start with a summary. */
export function WorkingList({
  onNavigate,
  runs,
}: {
  onNavigate: () => void;
  runs: readonly RailWorking[];
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((was) => !was), []);
  if (runs.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="Working"
      className="shrink-0 border-sidebar-border border-t px-2 [@media(min-width:768px)_and_(min-height:900px)]:py-1"
    >
      <button
        aria-expanded={expanded}
        className="flex min-h-10 w-full items-center gap-2 px-2 text-left font-medium text-sm [@media(min-width:768px)_and_(min-height:900px)]:hidden"
        onClick={toggle}
        type="button"
      >
        Working · {runs.length} running{" "}
        <span className="ml-auto">{expanded ? "⌄" : "›"}</span>
      </button>
      <div
        className={
          expanded
            ? "flex flex-col"
            : "hidden flex-col [@media(min-width:768px)_and_(min-height:900px)]:flex"
        }
      >
        <h2 className="flex justify-between px-2 py-1 font-medium text-[13px] text-muted-foreground max-md:hidden [@media(max-height:899px)]:hidden">
          Working <span>{runs.length}</span>
        </h2>
        {runs.slice(0, VISIBLE_WORKING).map((run) => (
          <WorkingRow key={run.id} onNavigate={onNavigate} run={run} />
        ))}
        <RailLink
          className="flex min-h-8 items-center px-2 text-(--df-electric-cyan) text-[13px] no-underline hover:underline"
          href="/sessions?working=true"
          onNavigate={onNavigate}
        >
          View all {runs.length} running
        </RailLink>
      </div>
    </section>
  );
}
