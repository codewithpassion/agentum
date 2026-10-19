import { EVENT_TYPES, type EventType, type RunStatus } from "@repo/db/shared";

export const LOG_PAGE_SIZE = 25;

const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "offered",
  "running",
];
/** The events that open a run. The button sits on them only, and `cancelEntryIds` puts it on one per run. */
const RUN_START_TYPES: readonly EventType[] = ["run.queued", "run.started"];

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isEventType = (value: string): value is EventType =>
  EVENT_TYPES.some((type) => type === value);

const startOfDay = (day: string): Date | undefined => {
  if (!DAY.test(day)) {
    return;
  }
  const date = new Date(`${day}T00:00:00.000Z`);
  // A day that rolls over (2026-02-31 becomes March 3) is not a date.
  if (Number.isNaN(date.getTime())) {
    return;
  }
  return date.toISOString().startsWith(day) ? date : undefined;
};

/**
 * The service filters for a range of days picked as `YYYY-MM-DD` dates, in UTC.
 * Both days are included: `from` is the start of its day and `to` is the start
 * of the day after. A value that is not a date is left out.
 */
export const dayRangeFilters = (
  from: string | undefined,
  to: string | undefined
): { from?: string; to?: string } => {
  const start = from === undefined ? undefined : startOfDay(from);
  const last = to === undefined ? undefined : startOfDay(to);
  return {
    from: start?.toISOString(),
    to:
      last === undefined
        ? undefined
        : new Date(last.getTime() + DAY_MS).toISOString(),
  };
};

/**
 * The ids of the entries that show Cancel: one per active run, on its newest
 * opening event in the list. Entries come newest first.
 */
export const cancelEntryIds = (
  entries: readonly {
    id: string;
    runId: string | null;
    runStatus: RunStatus | null;
    type: EventType;
  }[]
): Set<string> => {
  const runsWithButton = new Set<string>();
  const ids = new Set<string>();
  for (const entry of entries) {
    if (
      entry.runId === null ||
      entry.runStatus === null ||
      !ACTIVE_RUN_STATUSES.includes(entry.runStatus) ||
      !RUN_START_TYPES.includes(entry.type) ||
      runsWithButton.has(entry.runId)
    ) {
      continue;
    }
    runsWithButton.add(entry.runId);
    ids.add(entry.id);
  }
  return ids;
};
