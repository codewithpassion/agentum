import type { RailWorking } from "@repo/db/shared";
import { useCallback, useState } from "react";
import { RailLink } from "./rail-link.tsx";

const VISIBLE_WORKING = 3;

const ROW_CLASS =
  "flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-muted-foreground/70 text-sm no-underline hover:text-muted-foreground md:min-h-7";

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
        className="size-[7px] shrink-0 animate-pulse rounded-full bg-muted-foreground/40 [animation-duration:1.8s]"
      />
      <span className="truncate">{run.title}</span>
      <span className="ml-auto hidden shrink-0 text-xs group-hover/working:inline">
        {run.status}
      </span>
    </RailLink>
  );
}

/** At most three dim rows, and a row that shows the rest. */
export function WorkingList({
  onNavigate,
  runs,
}: {
  onNavigate: () => void;
  runs: readonly RailWorking[];
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((was) => !was), []);
  const shown = expanded ? runs : runs.slice(0, VISIBLE_WORKING);
  const hidden = runs.length - VISIBLE_WORKING;
  return (
    <div className="flex flex-col">
      {shown.map((run) => (
        <WorkingRow key={run.id} onNavigate={onNavigate} run={run} />
      ))}
      {hidden > 0 ? (
        <button
          aria-expanded={expanded}
          className={ROW_CLASS}
          onClick={toggle}
          type="button"
        >
          <span>{expanded ? "Show less" : `${hidden} more working`}</span>
        </button>
      ) : null}
    </div>
  );
}
