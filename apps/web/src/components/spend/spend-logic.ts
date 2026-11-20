import type { AgentSpendCap, SpendRow } from "@repo/db/shared";
import { weekCostLabel } from "#/components/roster/roster-logic.ts";

/** This week and the four before it. */
export const WEEKS_SHOWN = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_DAYS = 7;
const CENTS_PER_DOLLAR = 100;
const DOLLAR_INPUT = /^\$?\s*(\d+)(?:\.(\d{1,2}))?$/;

export interface SpendWeek {
  /** The last day counted, `YYYY-MM-DD`. Today for the current week. */
  end: string;
  /** "This week", "Last week", or the Monday as "Nov 9". */
  label: string;
  /** The Monday, `YYYY-MM-DD`. */
  start: string;
}

const dayFormatter = (timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  });

/** The calendar day of `now` in the workspace timezone, `YYYY-MM-DD`. */
export const dayInZone = (now: Date, timezone: string): string => {
  const parts = dayFormatter(timezone).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const addDays = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

const mondayOf = (day: string): string => {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((weekday + 6) % WEEK_DAYS));
};

const monthDay = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

const NAMED_WEEKS: Readonly<Record<number, string>> = {
  0: "This week",
  1: "Last week",
};

/** Five Monday-to-Sunday weeks, oldest first, the last one ending today. Weeks start Monday in the workspace timezone, as the server counts them. */
export const spendWeeks = (now: Date, timezone: string): SpendWeek[] => {
  const today = dayInZone(now, timezone);
  const thisMonday = mondayOf(today);
  return Array.from({ length: WEEKS_SHOWN }, (_, index) => {
    const back = WEEKS_SHOWN - 1 - index;
    const start = addDays(thisMonday, -back * WEEK_DAYS);
    return {
      end: back === 0 ? today : addDays(start, WEEK_DAYS - 1),
      label: NAMED_WEEKS[back] ?? monthDay(start),
      start,
    };
  });
};

/** The range one `spend.workspace` call needs to cover every week. */
export const spendRange = (weeks: readonly SpendWeek[]) => ({
  from: weeks[0]?.start ?? "",
  to: weeks.at(-1)?.end ?? "",
});

/** The cap as a short dollar amount: "$20", or "$20.50" when it has cents. */
export const capLabel = (cents: number): string =>
  cents % CENTS_PER_DOLLAR === 0
    ? `$${cents / CENTS_PER_DOLLAR}`
    : `$${(cents / CENTS_PER_DOLLAR).toFixed(2)}`;

/** "$4.10 of $20 this week", or null when no cap is set. */
export const capLine = (
  spentCents: number,
  capCents: number | null
): string | null =>
  capCents === null
    ? null
    : `${weekCostLabel(spentCents)} of ${capLabel(capCents)} this week`;

/** What a cap input holds for a saved cap: "20" or "20.5", empty for none. */
export const capInputValue = (cents: number | null): string =>
  cents === null ? "" : String(cents / CENTS_PER_DOLLAR);

export type CapInput =
  | { cents: number | null; ok: true }
  | { message: string; ok: false };

const CAP_MESSAGE = "Enter a dollar amount above zero, like 20 or 12.50.";

/** Reads a cap input. Empty means no cap. */
export const parseCapInput = (text: string): CapInput => {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { cents: null, ok: true };
  }
  const match = DOLLAR_INPUT.exec(trimmed);
  if (match === null) {
    return { message: CAP_MESSAGE, ok: false };
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const cents = whole * CENTS_PER_DOLLAR + fraction;
  return cents > 0 ? { cents, ok: true } : { message: CAP_MESSAGE, ok: false };
};

export interface SpendTableRow {
  agentId: string;
  /** The weekly limit, or null for none. */
  capCents: number | null;
  /** Cents per week, in the order of the weeks. */
  centsByWeek: number[];
  name: string;
  paused: boolean;
  /** True when the agent is no longer in the workspace's list. */
  removed: boolean;
}

export interface SpendTable {
  rows: SpendTableRow[];
  /** Cents per week that team dreams cost, charged to the workspace and to no agent. */
  teamCentsByWeek: number[];
  /** Cents per week across every agent shown and the team dreams, the way the workspace limit counts. */
  totals: number[];
}

const REMOVED_AGENT = "Removed agent";

/** One row per agent that spent in the five weeks or has a limit, this week's spend first. */
export const buildSpendTable = (input: {
  agents: readonly { id: string; name: string }[];
  caps: readonly AgentSpendCap[];
  rows: readonly SpendRow[];
  weeks: readonly SpendWeek[];
}): SpendTable => {
  const { agents, caps, rows, weeks } = input;
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const capOf = new Map(caps.map((cap) => [cap.agentId, cap]));
  const byAgent = new Map<string, SpendTableRow>();
  const teamCentsByWeek = weeks.map(() => 0);
  const current = weeks.length - 1;
  const entryFor = (agentId: string): SpendTableRow => {
    const existing = byAgent.get(agentId);
    if (existing) {
      return existing;
    }
    const name = names.get(agentId);
    const entry: SpendTableRow = {
      agentId,
      capCents: capOf.get(agentId)?.weeklyCapCents ?? null,
      centsByWeek: weeks.map(() => 0),
      name: name ?? REMOVED_AGENT,
      paused: (capOf.get(agentId)?.pausedAt ?? null) !== null,
      removed: name === undefined,
    };
    byAgent.set(agentId, entry);
    return entry;
  };
  // An agent with a limit shows even before it spends, so the limit is visible.
  for (const cap of caps) {
    if (
      names.has(cap.agentId) &&
      (cap.weeklyCapCents !== null || cap.pausedAt !== null)
    ) {
      entryFor(cap.agentId);
    }
  }
  for (const row of rows) {
    const index = weeks.findIndex(
      (week) => row.day >= week.start && row.day <= week.end
    );
    if (index === -1) {
      continue;
    }
    // A team dream has no agent to show: it is its own line.
    if (row.agentId === null) {
      teamCentsByWeek[index] = (teamCentsByWeek[index] ?? 0) + row.cents;
      continue;
    }
    const entry = entryFor(row.agentId);
    entry.centsByWeek[index] = (entry.centsByWeek[index] ?? 0) + row.cents;
  }
  const table = [...byAgent.values()].sort(
    (a, b) =>
      (b.centsByWeek[current] ?? 0) - (a.centsByWeek[current] ?? 0) ||
      a.name.localeCompare(b.name)
  );
  return {
    rows: table,
    teamCentsByWeek,
    totals: weeks.map(
      (_, index) =>
        (teamCentsByWeek[index] ?? 0) +
        table.reduce((sum, row) => sum + (row.centsByWeek[index] ?? 0), 0)
    ),
  };
};

/**
 * Gives each card that has a limit this week's spend counted from Monday in the
 * workspace timezone, the way the limit is counted. The roster's own figure
 * covers the last seven days, so the two could disagree about a limit.
 */
export const withLimitWeekSpend = <
  Card extends {
    costThisWeekCents: number;
    id: string;
    weeklyCapCents: number | null;
  },
>(
  cards: readonly Card[],
  weekRows: readonly SpendRow[]
): Card[] =>
  cards.map((card) =>
    card.weeklyCapCents === null
      ? card
      : {
          ...card,
          costThisWeekCents: weekRows
            .filter((row) => row.agentId === card.id)
            .reduce((total, row) => total + row.cents, 0),
        }
  );
