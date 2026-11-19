import {
  AGENT_CARD_STATES,
  type AgentAvatarColor,
  type AgentCard,
  type AgentCardState,
  type RailItem,
} from "@repo/db/shared";

/** Cards with a request waiting come first, then stopped, working and idle. Ties read by name. */
export const sortCards = (cards: readonly AgentCard[]): AgentCard[] =>
  [...cards].sort(
    (a, b) =>
      AGENT_CARD_STATES.indexOf(a.state) - AGENT_CARD_STATES.indexOf(b.state) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id)
  );

/** What the state dot means, for people who cannot see its colour. */
export const STATE_LABELS: Readonly<Record<AgentCardState, string>> = {
  idle: "Idle",
  needs_you: "Needs you",
  stopped: "Stopped",
  working: "Working",
};

/** Whole class names, so Tailwind finds them. */
export const STATE_DOT_CLASSES: Readonly<Record<AgentCardState, string>> = {
  idle: "bg-muted-foreground/50",
  needs_you: "bg-amber-500",
  stopped: "bg-destructive",
  working: "bg-emerald-500",
};

/** Whole class names, so Tailwind finds them. */
export const AVATAR_CLASSES: Readonly<Record<AgentAvatarColor, string>> = {
  amber: "bg-amber-600",
  blue: "bg-blue-600",
  green: "bg-emerald-600",
  orange: "bg-orange-600",
  red: "bg-rose-600",
  slate: "bg-slate-600",
  teal: "bg-teal-600",
  violet: "bg-violet-600",
};

/** A week of spend in dollars. Under a cent reads as "<$0.01", none as "$0". */
export const weekCostLabel = (cents: number): string => {
  if (cents <= 0) {
    return "$0";
  }
  return cents < 1 ? "<$0.01" : `$${(cents / 100).toFixed(2)}`;
};

export interface NeedsYouChip {
  /** The item pane that opens it. */
  href: string;
  id: string;
  title: string;
}

/** One chip per open Needs you item, in the order the rail gives them. */
export const chipsOf = (items: readonly RailItem[]): NeedsYouChip[] =>
  items.flatMap((item) => {
    const [first] = item.cards;
    return first === undefined
      ? []
      : [
          {
            href: `/desk?item=${encodeURIComponent(item.id)}`,
            id: item.id,
            title: first.title,
          },
        ];
  });
