import type { AgentCard } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { LayoutTemplate, type LucideIcon, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { RailLink } from "#/components/rail/rail-link.tsx";
import { AgentCardView } from "./agent-card.tsx";
import { type NeedsYouChip, sortCards } from "./roster-logic.ts";

const CHIP_CLASS =
  "max-w-full truncate rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-sm";

const ADD_CARD_CLASS =
  "flex min-h-28 items-center justify-center gap-2 rounded-xl border border-dashed border-border p-4 text-sm font-medium text-muted-foreground no-underline hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-foreground focus-visible:outline-offset-2";

// Both link to /agents/new, the agent builder.
const ADD_CARDS: readonly { icon: LucideIcon; label: string }[] = [
  { icon: Plus, label: "New agent" },
  { icon: LayoutTemplate, label: "Start from a template" },
];

const NeedsYouStrip = ({ chips }: { chips: readonly NeedsYouChip[] }) => (
  <section aria-label="Needs you" className="mb-6 flex flex-col gap-2">
    <h2 className="text-muted-foreground text-sm">Needs you</h2>
    <div className="flex flex-wrap gap-2">
      {chips.map((chip) => (
        <RailLink className={CHIP_CLASS} href={chip.href} key={chip.id}>
          {chip.title}
        </RailLink>
      ))}
    </div>
  </section>
);

/**
 * The Roster home: agents sorted by state, then the add-agent cards.
 * With no agents, `emptyState` replaces the "No agents yet" line and the add cards.
 */
export const RosterWall = ({
  cards,
  chips,
  emptyState,
}: {
  cards: readonly AgentCard[];
  chips: readonly NeedsYouChip[];
  emptyState?: ReactNode;
}) => {
  const isEmpty = cards.length === 0;
  const showEmptyState = isEmpty && emptyState !== undefined;
  return (
    <div>
      {chips.length > 0 ? <NeedsYouStrip chips={chips} /> : null}
      {showEmptyState ? emptyState : null}
      {isEmpty && !showEmptyState ? (
        <p className="mb-4 text-muted-foreground text-sm">
          No agents yet. Describe your first job and an agent will do it.
        </p>
      ) : null}
      {showEmptyState ? null : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sortCards(cards).map((card) => (
            <li key={card.id}>
              <AgentCardView card={card} />
            </li>
          ))}
          {ADD_CARDS.map(({ icon: Icon, label }) => (
            <li key={label}>
              <Link className={ADD_CARD_CLASS} to="/agents/new">
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                {label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
