// Reconnect backoff: exponential from 1s, capped at 60s, jittered so a relay
// restart does not bring the whole fleet back in lockstep.

export const BASE_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 60_000;

const JITTER_FLOOR = 0.8;
const JITTER_SPREAD = 0.4;

/**
 * Delay before reconnect attempt `attempt` (0-based). The jittered result is
 * clamped back into [BASE_BACKOFF_MS, MAX_BACKOFF_MS] so the documented range
 * holds at both ends.
 */
export const nextBackoffMs = (
  attempt: number,
  random: () => number = Math.random,
  baseMs: number = BASE_BACKOFF_MS,
  capMs: number = MAX_BACKOFF_MS
): number => {
  const safeAttempt = attempt < 0 ? 0 : attempt;
  const raw = Math.min(baseMs * 2 ** safeAttempt, capMs);
  const jittered = raw * (JITTER_FLOOR + JITTER_SPREAD * random());
  return Math.round(Math.min(Math.max(jittered, baseMs), capMs));
};
