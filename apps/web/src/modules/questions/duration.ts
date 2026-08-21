/**
 * `expires_in` as an agent writes it. Models reach for "30m" long before they
 * reach for 1800, so both are accepted and both land as seconds.
 *
 * The bounds are what keeps an expiry meaningful: under a minute nobody could
 * answer in time, and past a week the question has outlived whatever it was
 * blocking - at which point "no expiry" is the honest setting anyway.
 */

export const MIN_EXPIRES_IN_SECONDS = 60;
export const MAX_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

const DURATION =
  /^(\d+)\s*(s|sec|secs|seconds?|m|mins?|minutes?|h|hours?|d|days?)$/i;
/** A bare number, which is seconds. */
const SECONDS_ONLY = /^\d+$/;

const SECONDS_PER_UNIT: Record<string, number> = {
  d: 86_400,
  h: 3600,
  m: 60,
  s: 1,
};

export type ParsedDuration =
  | { ok: true; seconds: number | null }
  | { ok: false; reason: string };

const OUT_OF_RANGE = `"expires_in" must be between ${MIN_EXPIRES_IN_SECONDS} seconds and 7 days, for example "30m".`;

const inRange = (seconds: number): ParsedDuration =>
  seconds < MIN_EXPIRES_IN_SECONDS || seconds > MAX_EXPIRES_IN_SECONDS
    ? { ok: false, reason: OUT_OF_RANGE }
    : { ok: true, seconds };

/**
 * `undefined` and `null` both mean "no expiry", which is the default: most
 * questions should simply wait.
 */
export const parseExpiresIn = (raw: unknown): ParsedDuration => {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, seconds: null };
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw)
      ? inRange(Math.floor(raw))
      : { ok: false, reason: OUT_OF_RANGE };
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      reason:
        '"expires_in" must be a duration like "30m", or a number of seconds.',
    };
  }

  const trimmed = raw.trim();
  if (SECONDS_ONLY.test(trimmed)) {
    return inRange(Number.parseInt(trimmed, 10));
  }

  const match = DURATION.exec(trimmed);
  const unit = match?.[2]?.[0]?.toLowerCase();
  const amount = match?.[1];
  if (!(amount && unit)) {
    return {
      ok: false,
      reason: `"${raw}" is not a duration. Use something like "30m", "2h" or "1d".`,
    };
  }
  return inRange(Number.parseInt(amount, 10) * (SECONDS_PER_UNIT[unit] ?? 1));
};
