/**
 * Five-field cron with timezone-aware next-fire times, on `Intl` only. Copied
 * from bruce-next (`scheduler/cron.ts` and the parser of `cron/scheduler.ts`),
 * then changed at the DST edges.
 *
 * Fields are minute, hour, day of month, month, weekday (0 is Sunday). Each
 * accepts `*`, `N`, `N,M`, `N-M` and a `/step`. Day and weekday must both
 * match. There are no names, `L`, `W` or `#`.
 *
 * DST. A job whose hour field is `*` runs in real time, so a repeated hour
 * runs it twice and a skipped hour not at all. Any other job runs on the wall
 * clock. In the repeated hour of a fall-back it fires once, in the first pass.
 * A wall time inside the gap of a spring-forward fires once, at the moment the
 * gap ends. The upstream copy skipped that day and fired twice in the repeat.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const HOURS_PER_DAY = 24;
const WHITESPACE = /\s+/;
/** Safety limit on how far ahead `nextFireTime` searches (~4 years). */
const MAX_DAYS = 1461;

export const FIELD_NAMES = [
  "minute",
  "hour",
  "day",
  "month",
  "weekday",
] as const;
type FieldName = (typeof FIELD_NAMES)[number];

const RANGES: Record<FieldName, readonly [number, number]> = {
  day: [1, 31],
  hour: [0, 23],
  minute: [0, 59],
  month: [1, 12],
  weekday: [0, 6],
};

export type ParsedCron = Record<FieldName, Set<number>>;

const parseNumber = (text: string, spec: string): number => {
  const value = Number(text);
  if (text.trim() === "" || !Number.isInteger(value)) {
    throw new Error(`bad cron field '${spec}'`);
  }
  return value;
};

/** The first and last value of one list item, before its step. */
const itemBounds = (
  head: string,
  spec: string,
  lo: number,
  hi: number,
  stepped: boolean
): [number, number] => {
  if (head === "*") {
    return [lo, hi];
  }
  const [from = "", to] = head.split("-", 2);
  const start = parseNumber(from, spec);
  if (to === undefined) {
    // `5/15` runs from 5 to the end of the range, as in standard cron.
    return [start, stepped ? hi : start];
  }
  return [start, parseNumber(to, spec)];
};

const parseField = (spec: string, lo: number, hi: number): Set<number> => {
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const item = part.trim();
    if (item === "") {
      continue;
    }
    const [head = "", stepText] = item.split("/", 2);
    const step = stepText === undefined ? 1 : parseNumber(stepText, spec);
    if (step <= 0) {
      throw new Error(`bad cron step in '${spec}'`);
    }
    const [from, to] = itemBounds(head, spec, lo, hi, stepText !== undefined);
    if (from < lo || to > hi || from > to) {
      throw new Error(`bad cron field '${spec}' (range ${lo}-${hi})`);
    }
    for (let value = from; value <= to; value += step) {
      values.add(value);
    }
  }
  if (values.size === 0) {
    throw new Error(`empty cron field: '${spec}'`);
  }
  return values;
};

/** Throws on a malformed expression. */
export const parseCron = (expression: string): ParsedCron => {
  const parts = expression.trim().split(WHITESPACE);
  if (parts.length !== FIELD_NAMES.length) {
    throw new Error(
      `cron expression must have 5 fields, got ${parts.length}: '${expression}'`
    );
  }
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = parts;
  return {
    day: parseField(day, ...RANGES.day),
    hour: parseField(hour, ...RANGES.hour),
    minute: parseField(minute, ...RANGES.minute),
    month: parseField(month, ...RANGES.month),
    weekday: parseField(weekday, ...RANGES.weekday),
  };
};

export const isValidTimeZone = (timezone: string): boolean => {
  try {
    // Building the formatter throws on an unknown zone.
    formatterFor(timezone);
    return true;
  } catch {
    return false;
  }
};

export interface TzParts {
  day: number;
  hour: number;
  minute: number;
  month: number;
  /** 0 = Sunday. */
  weekday: number;
  year: number;
}

const WEEKDAYS: Record<string, number> = {
  Fri: 5,
  Mon: 1,
  Sat: 6,
  Sun: 0,
  Thu: 4,
  Tue: 2,
  Wed: 3,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timezone: string): Intl.DateTimeFormat => {
  const known = formatters.get(timezone);
  if (known) {
    return known;
  }
  const created = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    hour12: false,
    minute: "numeric",
    month: "numeric",
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
  });
  formatters.set(timezone, created);
  return created;
};

/** Wall-clock components of `date` in `timezone`. Throws on a bad zone. */
export const datePartsInTz = (date: Date, timezone: string): TzParts => {
  const parts = formatterFor(timezone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "0";
  return {
    day: Number(get("day")),
    // Intl may render midnight as "24" with hour12: false.
    hour: Number(get("hour")) % HOURS_PER_DAY,
    minute: Number(get("minute")),
    month: Number(get("month")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
    year: Number(get("year")),
  };
};

const floorToMinute = (ms: number): number =>
  Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/** The wall clock at `ms` in `timezone`, read as if it were UTC. */
const wallMs = (ms: number, timezone: string): number => {
  const p = datePartsInTz(new Date(ms), timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
};

/** The zone's UTC offset at `ms`, in milliseconds, to the minute. */
const offsetMs = (ms: number, timezone: string): number =>
  wallMs(ms, timezone) - floorToMinute(ms);

/**
 * Epoch ms of 00:00 (in `timezone`) on the day after the one containing
 * `ms`. Robust to 23- and 25-hour days.
 */
const startOfNextDay = (ms: number, timezone: string): number => {
  const p = datePartsInTz(new Date(ms), timezone);
  let t = ms + ((24 - p.hour) * 60 - p.minute) * MINUTE_MS;
  let q = datePartsInTz(new Date(t), timezone);
  // 25-hour day (fall-back): the jump lands at 23:00 of the same day.
  if (q.day === p.day && q.month === p.month) {
    t += HOUR_MS;
    q = datePartsInTz(new Date(t), timezone);
  }
  // 23-hour day (spring-forward): the jump lands at 01:00; snap back to
  // 00:00 unless that time doesn't exist in this zone (midnight transitions).
  const snapped = t - (q.hour * 60 + q.minute) * MINUTE_MS;
  const s = datePartsInTz(new Date(snapped), timezone);
  return s.day === q.day ? snapped : t;
};

type Step =
  | { kind: "found" }
  | { kind: "next-day" }
  | { kind: "advance"; ms: number };

/** What the walk does at wall-clock `p`: stop, skip the day, or move on. */
const stepAt = (fields: ParsedCron, p: TzParts): Step => {
  if (
    !(
      fields.month.has(p.month) &&
      fields.day.has(p.day) &&
      fields.weekday.has(p.weekday)
    )
  ) {
    return { kind: "next-day" };
  }
  if (!fields.hour.has(p.hour)) {
    return p.hour > Math.max(...fields.hour)
      ? { kind: "next-day" }
      : { kind: "advance", ms: (60 - p.minute) * MINUTE_MS };
  }
  if (fields.minute.has(p.minute)) {
    return { kind: "found" };
  }
  return {
    kind: "advance",
    ms:
      p.minute > Math.max(...fields.minute)
        ? (60 - p.minute) * MINUTE_MS
        : MINUTE_MS,
  };
};

/** The next minute after `after` whose wall clock matches. Real-time walk. */
const walk = (
  fields: ParsedCron,
  timezone: string,
  after: number
): number | null => {
  let t = floorToMinute(after) + MINUTE_MS;
  let days = 0;
  while (days < MAX_DAYS) {
    const step = stepAt(fields, datePartsInTz(new Date(t), timezone));
    if (step.kind === "found") {
      return t;
    }
    if (step.kind === "next-day") {
      t = startOfNextDay(t, timezone);
      days += 1;
    } else {
      t += step.ms;
    }
  }
  return null;
};

/**
 * Whether `t` is in the second pass of a fall-back hour: its wall time came
 * round once before.
 */
const isRepeatedPass = (t: number, timezone: string): boolean => {
  const now = offsetMs(t, timezone);
  const before = offsetMs(t - HOUR_MS, timezone);
  return before > now && offsetMs(t - (before - now), timezone) === before;
};

/** The first minute in (from, to] whose offset differs from `from`'s. */
const transitionBetween = (
  from: number,
  to: number,
  timezone: string
): number => {
  const start = offsetMs(from, timezone);
  let lo = from;
  let hi = to;
  while (hi - lo > MINUTE_MS) {
    const mid = lo + floorToMinute((hi - lo) / 2);
    if (offsetMs(mid, timezone) === start) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
};

/** Whether any wall minute `fields` skipped by a forward jump of `delta` matches. */
const gapMatches = (
  fields: ParsedCron,
  lastWall: number,
  delta: number
): boolean => {
  for (let skipped = MINUTE_MS; skipped <= delta; skipped += MINUTE_MS) {
    const wall = new Date(lastWall + skipped);
    if (
      fields.minute.has(wall.getUTCMinutes()) &&
      fields.hour.has(wall.getUTCHours()) &&
      fields.day.has(wall.getUTCDate()) &&
      fields.month.has(wall.getUTCMonth() + 1) &&
      fields.weekday.has(wall.getUTCDay())
    ) {
      return true;
    }
  }
  return false;
};

/**
 * The first spring-forward after `after`, up to `limit`, whose gap holds a
 * wall time `fields` match. The job fires when the gap ends. A transition is
 * looked for one day at a time, then narrowed to the minute.
 */
const gapFire = (
  fields: ParsedCron,
  timezone: string,
  after: number,
  limit: number
): number | null => {
  let from = floorToMinute(after);
  while (from < limit) {
    const to = from + DAY_MS;
    if (offsetMs(from, timezone) !== offsetMs(to, timezone)) {
      const at = transitionBetween(from, to, timezone);
      const delta = offsetMs(at, timezone) - offsetMs(at - MINUTE_MS, timezone);
      const lastWall = wallMs(at - MINUTE_MS, timezone);
      if (
        delta > 0 &&
        at > after &&
        at <= limit &&
        gapMatches(fields, lastWall, delta)
      ) {
        return at;
      }
    }
    from = to;
  }
  return null;
};

/**
 * Next time strictly after `after` at which `cron` matches in `timezone`.
 * Returns epoch ms, or null when nothing matches within ~4 years. Throws on
 * a malformed expression or unknown timezone.
 */
export const nextFireTime = (
  cron: string,
  timezone: string,
  after: Date = new Date()
): number | null => {
  const fields = parseCron(cron);
  const afterMs = after.getTime();
  let found = walk(fields, timezone, afterMs);
  if (fields.hour.size === HOURS_PER_DAY) {
    return found;
  }
  while (found !== null && isRepeatedPass(found, timezone)) {
    found = walk(fields, timezone, found);
  }
  const limit = found ?? afterMs + MAX_DAYS * DAY_MS;
  return gapFire(fields, timezone, afterMs, limit) ?? found;
};

/** Returns null when `expr` parses, else the parser's error message. */
export const validateCron = (expression: string): string | null => {
  try {
    parseCron(expression);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
