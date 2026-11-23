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

/** The size an agent card shares with the add tiles, so every tile in the wall matches. */
export const CARD_SIZE_CLASS = "h-full min-h-44";

/** One agent on the Roster home. The whole card opens the agent. */
export const AgentCardView = ({
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
        CARD_SIZE_CLASS,
        "flex min-w-0 gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground no-underline hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-foreground focus-visible:outline-offset-2",
        ACCENT_CLASSES[card.state]
      )}
      params={{ agentId: card.id }}
      to="/agents/$agentId"
    >
      <AgentTile avatar={card.avatar} size="lg" />
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
        <span className="line-clamp-2 block text-sm">
          {cardStatusLine(card, viewer)}
        </span>
        <span className="flex min-w-0 flex-wrap justify-between gap-x-3 text-muted-foreground text-xs">
          <span className="truncate">
            {card.ownerName === "" ? null : `Owner ${card.ownerName}`}
          </span>
          <span className="shrink-0">
            {capLine(weekCents, card.weeklyCapCents) ??
              `${weekCostLabel(weekCents)} this week`}
          </span>
        </span>
      </span>
    </Link>
  );
};
