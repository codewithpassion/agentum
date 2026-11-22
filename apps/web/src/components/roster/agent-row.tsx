import type { AgentCard } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { AgentTile } from "#/components/shell/agent-tile.tsx";
import { capLine } from "#/components/spend/spend-logic.ts";
import { useViewer } from "#/hooks/use-viewer.ts";
import { cn } from "#/lib/utils";
import {
  cardStatusLine,
  STATE_DOT_CLASSES,
  STATE_LABELS,
  weekCostLabel,
} from "./roster-logic.ts";

const ACCENT_CLASSES: Readonly<Partial<Record<AgentCard["state"], string>>> = {
  needs_you: "border-l-4 border-l-amber-500",
  stopped: "border-l-4 border-l-destructive",
};

/** One agent as a compact row on the Roster home: avatar, name, state, activity, owner and cost. The whole row opens the agent. */
export const AgentRowView = ({
  card,
  weekCents,
}: {
  card: AgentCard;
  /** This week's spend, as the Spend page counts it. */
  weekCents: number;
}) => {
  const viewer = useViewer();
  return (
    <Link
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-card-foreground text-sm no-underline hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-foreground focus-visible:outline-offset-2",
        ACCENT_CLASSES[card.state]
      )}
      params={{ agentId: card.id }}
      to="/agents/$agentId"
    >
      <AgentTile avatar={card.avatar} size="sm" />
      <span className="flex w-40 shrink-0 items-center gap-2 sm:w-56">
        <span className="truncate font-medium">{card.name}</span>
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full",
            STATE_DOT_CLASSES[card.state]
          )}
        />
        <span className="sr-only">{STATE_LABELS[card.state]}</span>
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {cardStatusLine(card, viewer)}
      </span>
      <span className="hidden w-40 shrink-0 truncate text-muted-foreground text-xs md:block">
        {card.ownerName === "" ? null : `Owner ${card.ownerName}`}
      </span>
      <span className="w-28 shrink-0 text-right text-muted-foreground text-xs">
        {capLine(weekCents, card.weeklyCapCents) ??
          `${weekCostLabel(weekCents)} this week`}
      </span>
    </Link>
  );
};
