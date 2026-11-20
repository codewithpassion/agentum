import {
  AGENT_CARD_STATES,
  type AgentAvatarColor,
  type AgentCard,
  type AgentCardState,
  type RailItem,
  type Team,
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

/** The key of the "No team" group. */
export const NO_TEAM_KEY = "no-team";

/** One roster group: a team's cards, or the cards with no home team. */
export interface RosterGroup {
  cards: AgentCard[];
  key: string;
  /** The name of the team's lead, when the lead is among the cards. */
  leadName: string | null;
  needsYouCount: number;
  /** The team, or null for the "No team" group. */
  team: Team | null;
}

const byTeamName = (a: Team, b: Team): number =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

const buildGroup = (
  key: string,
  team: Team | null,
  members: readonly AgentCard[],
  allCards: readonly AgentCard[]
): RosterGroup => {
  const leadId = team?.leadAgentId ?? null;
  const lead =
    leadId === null ? undefined : allCards.find((c) => c.id === leadId);
  return {
    cards: sortCards(members),
    key,
    leadName: lead?.name ?? null,
    needsYouCount: members.reduce((sum, c) => sum + c.needsYouCount, 0),
    team,
  };
};

/**
 * One group per team, by team name, then one "No team" group for cards whose
 * home team is missing or unknown. The "No team" group is left out when empty.
 */
export const groupCards = (
  cards: readonly AgentCard[],
  teams: readonly Team[]
): RosterGroup[] => {
  const teamIds = new Set(teams.map((team) => team.id));
  const groups = [...teams].sort(byTeamName).map((team) =>
    buildGroup(
      team.id,
      team,
      cards.filter((c) => c.teamId === team.id),
      cards
    )
  );
  const homeless = cards.filter(
    (c) => c.teamId === null || !teamIds.has(c.teamId)
  );
  if (homeless.length > 0) {
    groups.push(buildGroup(NO_TEAM_KEY, null, homeless, cards));
  }
  return groups;
};

type Store = Pick<Storage, "getItem" | "setItem">;

/** The storage key for one user's collapsed groups. */
export const collapsedKey = (userId: string): string =>
  `hm:roster-collapsed:${userId}`;

/** The group keys a user collapsed. Blocked or malformed storage reads as none. */
export const readCollapsed = (
  storage: () => Store,
  userId: string
): ReadonlySet<string> => {
  try {
    const raw = storage().getItem(collapsedKey(userId));
    if (raw === null) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(
      parsed.filter((entry): entry is string => typeof entry === "string")
    );
  } catch {
    return new Set();
  }
};

/** Keeps the collapsed group keys. When storage is blocked they are not kept. */
export const writeCollapsed = (
  storage: () => Store,
  userId: string,
  keys: ReadonlySet<string>
): void => {
  try {
    storage().setItem(collapsedKey(userId), JSON.stringify([...keys]));
  } catch {
    // Storage is blocked, so the choice is not kept.
  }
};

/** A copy of the set with the key added when absent, or removed when present. */
export const toggleKey = (
  keys: ReadonlySet<string>,
  key: string
): Set<string> => {
  const next = new Set(keys);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
};
