import { Link } from "@tanstack/react-router";
import { useCallback } from "react";
import { Button } from "#/components/ui/button.tsx";
import type { Helper } from "./now-logic.ts";

/** One helper as a pill: its title and model link to the run, and a Stop button ends it. */
function HelperChip({
  busy,
  helper,
  onStop,
}: {
  busy: boolean;
  helper: Helper;
  onStop: (runId: string) => void;
}) {
  const stop = useCallback(() => onStop(helper.id), [helper.id, onStop]);
  return (
    <li
      className="flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border py-1 pr-1 pl-3"
      data-testid="helper-chip"
    >
      <Link
        className="group flex min-w-0 items-baseline gap-2"
        params={{ runId: helper.id }}
        to="/tasks/$runId"
      >
        <span className="truncate font-semibold text-sm group-hover:underline">
          {helper.title}
        </span>
        <span className="shrink-0 text-muted-foreground text-xs">
          {helper.model}
        </span>
      </Link>
      <Button
        aria-label={`Stop ${helper.title}`}
        className="pointer-coarse:min-h-10"
        disabled={busy}
        onClick={stop}
        size="sm"
        type="button"
        variant="outline"
      >
        {busy ? "Stopping…" : "Stop"}
      </Button>
    </li>
  );
}

/** The helpers still working for a run, each with a Stop button. Renders nothing when none is working. */
export function HelpersCard({
  busyIds,
  helpers,
  onStop,
}: {
  /** The helpers whose Stop is in flight. */
  busyIds: readonly string[];
  helpers: readonly Helper[];
  onStop: (runId: string) => void;
}) {
  if (helpers.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="Helpers"
      className="min-w-0 rounded-lg border border-border bg-card"
      data-testid="now-helpers"
    >
      <h2 className="px-4 py-3 font-semibold text-sm">Helpers</h2>
      <ul className="flex flex-wrap gap-2 px-4 pb-3">
        {helpers.map((helper) => (
          <HelperChip
            busy={busyIds.includes(helper.id)}
            helper={helper}
            key={helper.id}
            onStop={onStop}
          />
        ))}
      </ul>
    </section>
  );
}
