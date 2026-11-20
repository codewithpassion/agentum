import type { SpendRow } from "@repo/db/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

const dayFormatter = (timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  });

const formattedDay = (formatter: Intl.DateTimeFormat, at: string | Date) => {
  const parts = formatter.formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};

export const dayInTimezone = (at: string | Date, timezone: string): string =>
  formattedDay(dayFormatter(timezone), at);

/** Monday's calendar day; filtering local days handles DST without assuming 24-hour days. */
export const mondayWeekStart = (now: Date, timezone: string): string => {
  const date = new Date(`${dayInTimezone(now, timezone)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
};

/** One extra UTC day on each side covers every IANA timezone offset. */
export const paddedWindow = (from: string, to: string) => ({
  end: new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY_MS).toISOString(),
  start: new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS).toISOString(),
});

export interface SpendFact {
  /** The agent that spent. Null for a team dream. */
  agentId: string | null;
  at: string;
  costUsd: number;
  tasks: number;
  /** The team whose dream spent it. Set with `agentId` null. */
  teamId?: string;
}

const newRow = (fact: SpendFact, day: string): SpendRow => ({
  agentId: fact.agentId,
  cents: 0,
  day,
  tasks: 0,
  ...(fact.teamId === undefined ? {} : { teamId: fact.teamId }),
});

/** The agent's id, or the team's for a team row. Sorts agents and teams together. */
const sortName = (row: SpendRow): string => row.agentId ?? row.teamId ?? "";

export const rollupSpend = (
  facts: readonly SpendFact[],
  timezone: string,
  range: { from: string; to: string }
): SpendRow[] => {
  const formatter = dayFormatter(timezone);
  const buckets = new Map<string, SpendRow>();
  for (const fact of facts) {
    const day = formattedDay(formatter, fact.at);
    if (day < range.from || day > range.to) {
      continue;
    }
    const key = JSON.stringify([day, fact.agentId, fact.teamId ?? null]);
    const row = buckets.get(key) ?? newRow(fact, day);
    // Keep USD in the accumulator, then convert and round once per agent-day.
    row.cents += fact.costUsd;
    row.tasks += fact.tasks;
    buckets.set(key, row);
  }
  return Array.from(buckets.values(), (row) => ({
    ...row,
    cents: Math.round(row.cents * 100),
  })).sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      sortName(a).localeCompare(sortName(b)) ||
      (a.teamId ?? "").localeCompare(b.teamId ?? "")
  );
};
