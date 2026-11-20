import type { AgentCard } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { capLine } from "#/components/spend/spend-logic.ts";
import { cn } from "#/lib/utils";
import {
  AVATAR_CLASSES,
  STATE_DOT_CLASSES,
  STATE_LABELS,
  weekCostLabel,
} from "./roster-logic.ts";

const ACCENT_CLASSES: Readonly<Partial<Record<AgentCard["state"], string>>> = {
  needs_you: "border-l-4 border-l-amber-500",
  stopped: "border-l-4 border-l-destructive",
};

/** One agent on the Roster home. The whole card opens the agent. */
export const AgentCardView = ({ card }: { card: AgentCard }) => (
  <Link
    className={cn(
      "flex min-w-0 gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground no-underline hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-foreground focus-visible:outline-offset-2",
      ACCENT_CLASSES[card.state]
    )}
    params={{ agentId: card.id }}
    to="/agents/$agentId"
  >
    <span
      aria-hidden="true"
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg font-semibold text-white",
        AVATAR_CLASSES[card.avatar.color]
      )}
    >
      {card.avatar.glyph}
    </span>
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium">{card.name}</span>
        {card.isLead ? (
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-muted-foreground text-xs">
            Lead
          </span>
        ) : null}
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full",
            STATE_DOT_CLASSES[card.state]
          )}
        />
        <span className="sr-only">{STATE_LABELS[card.state]}</span>
      </span>
      {card.jobLine === "" ? null : (
        <span className="line-clamp-2 block text-muted-foreground text-sm">
          {card.jobLine}
        </span>
      )}
      <span className="line-clamp-2 block text-sm">{card.statusLine}</span>
      <span className="flex min-w-0 flex-wrap justify-between gap-x-3 text-muted-foreground text-xs">
        <span className="truncate">
          {card.ownerName === "" ? null : `Owner ${card.ownerName}`}
        </span>
        <span className="shrink-0">
          {capLine(card.costThisWeekCents, card.weeklyCapCents) ??
            `${weekCostLabel(card.costThisWeekCents)} this week`}
        </span>
      </span>
    </span>
  </Link>
);
