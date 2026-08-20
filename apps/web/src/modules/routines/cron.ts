/**
 * The cron escape hatch: the classic five-field form, parsed in-repo rather
 * than pulled in as a dependency.
 *
 * ```
 * minute  hour  day-of-month  month  day-of-week
 * 0-59    0-23  1-31          1-12   0-7 (0 and 7 are both Sunday)
 * ```
 *
 * Each field takes `*`, a number, a range (`1-5`), a step over either (a
 * star or a range followed by `/5`) and comma-separated lists of those.
 *
 * **Not supported**, and rejected rather than guessed at: month and weekday
 * names (`JAN`, `MON`), the `@yearly`/`@daily` macros, `?`, `L`, `W`, `#`,
 * step-from-a-single-value (`5/10`), and the optional second and year fields
 * some dialects add. Everything a preset can express is already a preset; this
 * is for the rest.
 *
 * Matching follows Vixie cron's day rule: when *both* day fields are
 * restricted, a day matching either one fires; otherwise both must match.
 */

export interface CronFields {
  daysOfMonth: number[];
  daysOfWeek: number[];
  /** Whether `day-of-month` was narrowed - half of the Vixie day rule. */
  domRestricted: boolean;
  /** Whether `day-of-week` was narrowed - the other half. */
  dowRestricted: boolean;
  hours: number[];
  minutes: number[];
  months: number[];
}

/** A local calendar day, as the walk in `schedule.ts` produces them. */
export interface CronDay {
  day: number;
  month: number;
  /** 0 = Sunday. */
  weekday: number;
}

const CRON_FIELD_COUNT = 5;
const WHITESPACE = /\s+/;
const NUMBER = /^\d+$/;
const RANGE = /^(\d+)-(\d+)$/;
const SUNDAY_ALIAS = 7;

interface Bounds {
  max: number;
  min: number;
}

const MINUTES: Bounds = { max: 59, min: 0 };
const HOURS: Bounds = { max: 23, min: 0 };
const DAYS_OF_MONTH: Bounds = { max: 31, min: 1 };
const MONTHS: Bounds = { max: 12, min: 1 };
const DAYS_OF_WEEK: Bounds = { max: 7, min: 0 };

const expandStep = (from: number, to: number, step: number): number[] => {
  const values: number[] = [];
  for (let value = from; value <= to; value += step) {
    values.push(value);
  }
  return values;
};

/** One comma-separated term: a star, `7`, `1-5`, a star stepped by 15, `1-5/2`. */
const expandTerm = (term: string, bounds: Bounds): number[] | null => {
  const [spec, stepRaw, ...extra] = term.split("/");
  if (extra.length > 0 || spec === undefined) {
    return null;
  }

  let step = 1;
  if (stepRaw !== undefined) {
    if (!NUMBER.test(stepRaw)) {
      return null;
    }
    step = Number.parseInt(stepRaw, 10);
    if (step === 0) {
      return null;
    }
  }

  if (spec === "*") {
    return expandStep(bounds.min, bounds.max, step);
  }

  const range = RANGE.exec(spec);
  if (range?.[1] !== undefined && range[2] !== undefined) {
    const from = Number.parseInt(range[1], 10);
    const to = Number.parseInt(range[2], 10);
    if (from < bounds.min || to > bounds.max || from > to) {
      return null;
    }
    return expandStep(from, to, step);
  }

  if (!NUMBER.test(spec) || stepRaw !== undefined) {
    // A bare number with a step (`5/10`) is a dialect extension, not the
    // classic form - rejected rather than interpreted.
    return null;
  }
  const value = Number.parseInt(spec, 10);
  if (value < bounds.min || value > bounds.max) {
    return null;
  }
  return [value];
};

const parseField = (raw: string, bounds: Bounds): number[] | null => {
  const values = new Set<number>();
  for (const term of raw.split(",")) {
    const expanded = expandTerm(term, bounds);
    if (!expanded) {
      return null;
    }
    for (const value of expanded) {
      values.add(value);
    }
  }
  return [...values].sort((a, b) => a - b);
};

export const parseCron = (expr: string): CronFields | null => {
  const fields = expr.trim().split(WHITESPACE);
  if (fields.length !== CRON_FIELD_COUNT) {
    return null;
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const minutes = parseField(minuteRaw, MINUTES);
  const hours = parseField(hourRaw, HOURS);
  const daysOfMonth = parseField(domRaw, DAYS_OF_MONTH);
  const months = parseField(monthRaw, MONTHS);
  const rawDaysOfWeek = parseField(dowRaw, DAYS_OF_WEEK);
  if (!(minutes && hours && daysOfMonth && months && rawDaysOfWeek)) {
    return null;
  }

  // Both 0 and 7 mean Sunday; the walk only ever asks about 0-6.
  const daysOfWeek = [
    ...new Set(rawDaysOfWeek.map((day) => (day === SUNDAY_ALIAS ? 0 : day))),
  ].sort((a, b) => a - b);

  return {
    daysOfMonth,
    daysOfWeek,
    domRestricted: domRaw !== "*",
    dowRestricted: dowRaw !== "*",
    hours,
    minutes,
    months,
  };
};

/** Whether a calendar day is one this expression fires on. */
export const cronMatchesDay = (fields: CronFields, day: CronDay): boolean => {
  if (!fields.months.includes(day.month)) {
    return false;
  }
  const dayOfMonth = fields.daysOfMonth.includes(day.day);
  const dayOfWeek = fields.daysOfWeek.includes(day.weekday);
  if (fields.domRestricted && fields.dowRestricted) {
    return dayOfMonth || dayOfWeek;
  }
  return dayOfMonth && dayOfWeek;
};
