import { nextRun, type Schedule } from "#/modules/routines/schedule";

/**
 * How a schedule reads on screen, and when it fires next.
 *
 * `nextRun` is pure and ships to the browser unchanged, so the form can show
 * the next three firings while you are still typing - the same arithmetic the
 * scheduler will do, rather than a hopeful approximation of it. Everything here
 * is presentation on top of that.
 */

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 0 = Sunday, matching the schedule's `day`. */
export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const WEEKDAY_PLURALS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
] as const;

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

const plural = (count: number, unit: string): string =>
  count === 1 ? `1 ${unit}` : `${count} ${unit}s`;

const dayOf = (timestamp: number, timeZone: string): string =>
  new Date(timestamp).toLocaleDateString([], {
    day: "numeric",
    month: "short",
    timeZone,
    year: "numeric",
  });

const clockOf = (timestamp: number, timeZone: string): string =>
  new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
  });

/**
 * An instant as the routine's own time zone sees it - a next run is a promise
 * about a wall clock somewhere, and showing it in the reader's zone instead
 * would quietly change what was promised.
 */
export const formatInZone = (timestamp: number, timeZone: string): string => {
  try {
    return `${dayOf(timestamp, timeZone)}, ${clockOf(timestamp, timeZone)}`;
  } catch {
    // An unknown zone is already reported by the form; fall back rather than
    // taking the screen down with it.
    return new Date(timestamp).toLocaleString();
  }
};

/** The forward-looking twin of `formatRelativeTime`: "in 2h", not "2h ago". */
export const formatUntil = (timestamp: number, now = Date.now()): string => {
  const remaining = timestamp - now;
  if (remaining <= 0) {
    return "due now";
  }
  if (remaining < MINUTE_MS) {
    return "in under a minute";
  }
  if (remaining < HOUR_MS) {
    return `in ${Math.floor(remaining / MINUTE_MS)}m`;
  }
  if (remaining < DAY_MS) {
    return `in ${Math.floor(remaining / HOUR_MS)}h`;
  }
  return `in ${Math.floor(remaining / DAY_MS)}d`;
};

/** The wall clock a "once" names, read straight off the string it is stored as. */
const describeOnce = (value: string): string => {
  const match = LOCAL_DATETIME.exec(value);
  if (!match) {
    return value;
  }
  const [, year, month, day, hour, minute] = match;
  const asUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute)
  );
  return `${dayOf(asUtc, "UTC")}, ${hour}:${minute}`;
};

const describeInterval = (everyMinutes: number): string => {
  if (everyMinutes % MINUTES_PER_DAY === 0) {
    return `Every ${plural(everyMinutes / MINUTES_PER_DAY, "day")}`;
  }
  if (everyMinutes % MINUTES_PER_HOUR === 0) {
    return `Every ${plural(everyMinutes / MINUTES_PER_HOUR, "hour")}`;
  }
  return `Every ${plural(everyMinutes, "minute")}`;
};

/**
 * A schedule in a sentence. The time zone rides along for everything anchored
 * to a wall clock; an interval is the same length of time everywhere, so naming
 * a zone next to it would only mislead.
 *
 * `null` is a stored schedule that no longer parses - the row still lists, it
 * just says so.
 */
export const describeSchedule = (
  schedule: Schedule | null,
  timezone: string
): string => {
  if (!schedule) {
    return "Unreadable schedule";
  }
  const zone = ` (${timezone})`;
  switch (schedule.type) {
    case "once":
      return `Once: ${describeOnce(schedule.at)}${zone}`;
    case "daily":
      return `Every ${schedule.weekdaysOnly ? "weekday" : "day"} at ${schedule.time}${zone}`;
    case "weekly":
      return `${WEEKDAY_PLURALS[schedule.day] ?? "Weekly"} at ${schedule.time}${zone}`;
    case "interval":
      return describeInterval(schedule.everyMinutes);
    case "cron":
      return `Cron: ${schedule.expr}${zone}`;
    default:
      return "Unreadable schedule";
  }
};

/**
 * The next `count` firings, each one found by asking again from the one before
 * it. A "once" answers with a single entry and a spent one with none, which is
 * exactly what the form needs to say "this will never run" before you save it.
 */
export const nextRuns = (
  schedule: Schedule,
  timezone: string,
  count: number,
  after: Date = new Date()
): Date[] => {
  const runs: Date[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    const run = nextRun(schedule, timezone, cursor);
    if (!run) {
      break;
    }
    runs.push(run);
    cursor = run;
  }
  return runs;
};
