import type { DeskLane } from "@repo/db/shared";
import { Children, type ReactNode } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { laneLabel } from "./desk-logic.ts";

/** One lane of the desk: a header with its count, then the cards. */
export function DeskLaneColumn({
  children,
  count,
  lane,
  more,
}: {
  children: ReactNode;
  count: number;
  lane: DeskLane;
  more?: number;
}) {
  const extra = more ?? 0;
  const isEmpty = count === 0 && Children.toArray(children).length === 0;

  return (
    <section
      aria-label={laneLabel(lane)}
      className="flex min-w-0 flex-col gap-2.5 rounded-xl bg-muted/60 p-2.5"
      data-testid={`lane-${lane}`}
    >
      <header className="flex items-center justify-between px-1 py-0.5 font-semibold text-sm">
        <span>{laneLabel(lane)}</span>
        <Badge variant="secondary">{count}</Badge>
      </header>
      {isEmpty ? (
        <p className="px-1 text-muted-foreground text-xs">Nothing here.</p>
      ) : (
        children
      )}
      {extra > 0 ? (
        <p className="px-1 text-muted-foreground text-xs">+ {extra} more</p>
      ) : null}
    </section>
  );
}
