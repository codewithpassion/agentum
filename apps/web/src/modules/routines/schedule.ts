import { type CronFields, cronMatchesDay, parseCron } from "./cron";

/**
 * The one pure function routines lean on: `nextRun(schedule, timezone, after)`.
 * Everything else here exists to serve it - the shapes a schedule can take, the
 * parser that validates one off the wire, and the time-zone arithmetic.
 *
 * Wall-clock times are stored, not instants: "every weekday at 09:00" means
 * 09:00 where the routine's owner lives, on both sides of a daylight-saving
 * change. Workers ship full ICU, so `Intl` is the whole time-zone database -
 * the conversion below formats an instant into the zone to learn its offset,
 * then subtracts that offset from the wanted wall clock to get back an instant.
 *
 * A wall clock that daylight saving skipped (02:30 on a spring-forward morning)
 * resolves to the instant one offset-step later - the routine fires at 03:30
 * that day rather than not at all. One that happens twice (01:30 on a
 * fall-back morning) resolves to the first of the two, so it still fires once.
 */

export interface OnceSchedule {
  /** Local wall clock, `YYYY-MM-DDTHH:mm` - no zone suffix, that is `timezone`. */
  at: string;
  type: "once";
}

export interface DailySchedule {
  /** `HH:mm`, 24-hour. */
  time: string;
  type: "daily";
  /** Monday to Friday only. */
  weekdaysOnly?: boolean;
}

export interface WeeklySchedule {
  /** 0 = Sunday. */
  day: number;
  time: string;
  type: "weekly";
}

export interface IntervalSchedule {
  everyMinutes: number;
  type: "interval";
}

export interface CronSchedule {
  /** Five fields; see `cron.ts` for the supported subset. */
  expr: string;
  type: "cron";
}

export type Schedule =
  | CronSchedule
  | DailySchedule
  | IntervalSchedule
  | OnceSchedule
  | WeeklySchedule;

export type ParsedSchedule =
  | { ok: false; reason: string }
  | { ok: true; schedule: Schedule };

/** Below this an interval stops being a routine and starts being a poll loop. */
export const MIN_INTERVAL_MINUTES = 15;
/** A month; past it, "once" or a cron expression says it better. */
export const MAX_INTERVAL_MINUTES = 44_640;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL_DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const DAYS_IN_WEEK = 7;
/** A daily or weekly schedule is always within a week of any instant. */
const CALENDAR_SEARCH_DAYS = 8;
/** Four years of days: enough for `0 0 29 2 *` to find a leap year. */
const CRON_SEARCH_DAYS = 1500;

// --- time zones -------------------------------------------------------------

interface WallClock {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
}

interface LocalDate {
  day: number;
  month: number;
  year: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const cached = formatters.get(timeZone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  });
  formatters.set(timeZone, formatter);
  return formatter;
};

/** Whether `Intl` knows the zone - the check behind the API's validation. */
export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
};

const wallClockIn = (instant: Date, timeZone: string): WallClock => {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? "0", 10);
  return {
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    month: read("month"),
    second: read("second"),
    year: read("year"),
  };
};

const asUtcMs = (wall: WallClock): number =>
  Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second
  );

/** How far the zone is from UTC at that instant, in milliseconds. */
const offsetMsAt = (instant: Date, timeZone: string): number =>
  asUtcMs(wallClockIn(instant, timeZone)) - instant.getTime();

/**
 * The instant a local wall clock names.
 *
 * Both offsets that could apply are tried - the one in force the day before
 * and the one in force the day after - and each candidate is checked by
 * formatting it back into the zone. On an ordinary day they agree. On a
 * fall-back day both are real and the earlier is taken, so a routine fires once
 * rather than twice. On a spring-forward day neither reads back, because the
 * wall clock never happened: the pre-transition offset is used, which lands the
 * routine one step past the gap (02:30 becomes 03:30).
 */
const instantFor = (wall: WallClock, timeZone: string): Date => {
  const wanted = asUtcMs(wall);
  const beforeTransition =
    wanted - offsetMsAt(new Date(wanted - DAY_MS), timeZone);
  const afterTransition =
    wanted - offsetMsAt(new Date(wanted + DAY_MS), timeZone);

  const real = [beforeTransition, afterTransition].filter(
    (candidate) =>
      asUtcMs(wallClockIn(new Date(candidate), timeZone)) === wanted
  );
  return new Date(real.length > 0 ? Math.min(...real) : beforeTransition);
};

const localDateOf = (instant: Date, timeZone: string): LocalDate => {
  const wall = wallClockIn(instant, timeZone);
  return { day: wall.day, month: wall.month, year: wall.year };
};

const addDays = (date: LocalDate, days: number): LocalDate => {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return {
    day: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    year: shifted.getUTCFullYear(),
  };
};

/** 0 = Sunday, for the local calendar date rather than any instant. */
const weekdayOf = (date: LocalDate): number =>
  new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();

const isWeekday = (date: LocalDate): boolean => {
  const weekday = weekdayOf(date);
  return weekday !== 0 && weekday !== 6;
};

const at = (
  date: LocalDate,
  hour: number,
  minute: number,
  timeZone: string
): Date => instantFor({ ...date, hour, minute, second: 0 }, timeZone);

// --- parsing ----------------------------------------------------------------

const readTime = (value: unknown): [number, number] | null => {
  if (typeof value !== "string") {
    return null;
  }
  const match = TIME_PATTERN.exec(value);
  if (!(match?.[1] && match[2])) {
    return null;
  }
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)];
};

const readLocalDateTime = (value: string): WallClock | null => {
  const match = LOCAL_DATETIME_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = match;
  if (!(year && month && day && hour && minute)) {
    return null;
  }
  const wall: WallClock = {
    day: Number.parseInt(day, 10),
    hour: Number.parseInt(hour, 10),
    minute: Number.parseInt(minute, 10),
    month: Number.parseInt(month, 10),
    second: second ? Number.parseInt(second, 10) : 0,
    year: Number.parseInt(year, 10),
  };
  // Rejects 31 February and friends: the round trip moves a date that does not
  // exist onto one that does.
  const roundTrip = new Date(asUtcMs(wall));
  if (
    roundTrip.getUTCFullYear() !== wall.year ||
    roundTrip.getUTCMonth() + 1 !== wall.month ||
    roundTrip.getUTCDate() !== wall.day
  ) {
    return null;
  }
  return wall;
};

const parseOnce = (input: Record<string, unknown>): ParsedSchedule => {
  const value = input.at;
  if (typeof value !== "string" || !readLocalDateTime(value)) {
    return {
      ok: false,
      reason: '"at" must be a local date and time, like "2026-08-21T09:00".',
    };
  }
  return { ok: true, schedule: { at: value, type: "once" } };
};

const parseDaily = (input: Record<string, unknown>): ParsedSchedule => {
  const time = typeof input.time === "string" ? input.time : "";
  if (!readTime(time)) {
    return { ok: false, reason: '"time" must look like "09:00".' };
  }
  const { weekdaysOnly } = input;
  if (weekdaysOnly !== undefined && typeof weekdaysOnly !== "boolean") {
    return { ok: false, reason: '"weekdaysOnly" must be a boolean.' };
  }
  return {
    ok: true,
    schedule: {
      time,
      type: "daily",
      ...(weekdaysOnly === undefined ? {} : { weekdaysOnly }),
    },
  };
};

const parseWeekly = (input: Record<string, unknown>): ParsedSchedule => {
  const time = typeof input.time === "string" ? input.time : "";
  if (!readTime(time)) {
    return { ok: false, reason: '"time" must look like "09:00".' };
  }
  const { day } = input;
  if (
    typeof day !== "number" ||
    !Number.isInteger(day) ||
    day < 0 ||
    day > DAYS_IN_WEEK - 1
  ) {
    return {
      ok: false,
      reason: '"day" must be a weekday number, 0 (Sunday) to 6 (Saturday).',
    };
  }
  return { ok: true, schedule: { day, time, type: "weekly" } };
};

const parseInterval = (input: Record<string, unknown>): ParsedSchedule => {
  const { everyMinutes } = input;
  if (
    typeof everyMinutes !== "number" ||
    !Number.isInteger(everyMinutes) ||
    everyMinutes < MIN_INTERVAL_MINUTES ||
    everyMinutes > MAX_INTERVAL_MINUTES
  ) {
    return {
      ok: false,
      reason: `"everyMinutes" must be a whole number of minutes between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}.`,
    };
  }
  return { ok: true, schedule: { everyMinutes, type: "interval" } };
};

const parseCronSchedule = (input: Record<string, unknown>): ParsedSchedule => {
  const { expr } = input;
  if (typeof expr !== "string" || !parseCron(expr)) {
    return {
      ok: false,
      reason:
        '"expr" must be a five-field cron expression, like "0 9 * * 1-5". Names, macros and L/W/# are not supported.',
    };
  }
  return { ok: true, schedule: { expr: expr.trim(), type: "cron" } };
};

/**
 * A schedule off the wire (or out of the database) into the union, with the
 * reason it was refused when it does not fit. The API answers 400 with that
 * reason, so it is written for a person to read.
 */
export const parseSchedule = (value: unknown): ParsedSchedule => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: '"schedule" must be an object.' };
  }
  const input = value as Record<string, unknown>;
  switch (input.type) {
    case "once":
      return parseOnce(input);
    case "daily":
      return parseDaily(input);
    case "weekly":
      return parseWeekly(input);
    case "interval":
      return parseInterval(input);
    case "cron":
      return parseCronSchedule(input);
    default:
      return {
        ok: false,
        reason:
          '"schedule.type" must be one of: once, daily, weekly, interval, cron.',
      };
  }
};

// --- the next run -----------------------------------------------------------

const nextOnce = (
  schedule: OnceSchedule,
  timeZone: string,
  after: Date
): Date | null => {
  const wall = readLocalDateTime(schedule.at);
  if (!wall) {
    return null;
  }
  const instant = instantFor(wall, timeZone);
  return instant.getTime() > after.getTime() ? instant : null;
};

/**
 * Daily and weekly walk the local calendar a day at a time rather than adding
 * 24 hours: on a daylight-saving day the wanted wall clock is 23 or 25 hours
 * away, and it is the wall clock that is promised.
 */
const nextCalendar = (
  schedule: DailySchedule | WeeklySchedule,
  timeZone: string,
  after: Date
): Date | null => {
  const time = readTime(schedule.time);
  if (!time) {
    return null;
  }
  const [hour, minute] = time;
  let date = localDateOf(after, timeZone);

  for (let step = 0; step < CALENDAR_SEARCH_DAYS; step += 1) {
    const wanted =
      schedule.type === "weekly"
        ? weekdayOf(date) === schedule.day
        : !schedule.weekdaysOnly || isWeekday(date);
    if (wanted) {
      const instant = at(date, hour, minute, timeZone);
      if (instant.getTime() > after.getTime()) {
        return instant;
      }
    }
    date = addDays(date, 1);
  }
  return null;
};

const nextCronRun = (
  fields: CronFields,
  timeZone: string,
  after: Date
): Date | null => {
  let date = localDateOf(after, timeZone);

  for (let step = 0; step < CRON_SEARCH_DAYS; step += 1) {
    if (cronMatchesDay(fields, { ...date, weekday: weekdayOf(date) })) {
      for (const hour of fields.hours) {
        for (const minute of fields.minutes) {
          const instant = at(date, hour, minute, timeZone);
          if (instant.getTime() > after.getTime()) {
            return instant;
          }
        }
      }
    }
    date = addDays(date, 1);
  }
  return null;
};

/**
 * When this schedule next fires strictly after `after`, or null when it never
 * will again - which is how a "once" in the past disables its routine.
 *
 * An unparseable schedule or an unknown zone answers null too: a routine whose
 * definition stopped making sense must stop firing, not throw inside an alarm.
 */
export const nextRun = (
  schedule: Schedule,
  timezone: string,
  after: Date
): Date | null => {
  if (!isValidTimeZone(timezone)) {
    return null;
  }
  switch (schedule.type) {
    case "once":
      return nextOnce(schedule, timezone, after);
    case "daily":
    case "weekly":
      return nextCalendar(schedule, timezone, after);
    case "interval": {
      if (schedule.everyMinutes < MIN_INTERVAL_MINUTES) {
        return null;
      }
      return new Date(after.getTime() + schedule.everyMinutes * MINUTE_MS);
    }
    case "cron": {
      const fields = parseCron(schedule.expr);
      return fields ? nextCronRun(fields, timezone, after) : null;
    }
    default:
      return null;
  }
};
