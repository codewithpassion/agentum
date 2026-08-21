import {
  AVAILABLE_MODEL_IDS,
  isAvailableModel,
} from "#/modules/anthropic/config";
import {
  isValidTimeZone,
  nextRun,
  parseSchedule,
  type Schedule,
} from "./schedule";
import type { Routine } from "./schema";
import { scheduleOf } from "./service";

/**
 * What makes a routine well-formed, in the one place both callers can reach.
 *
 * The HTTP routes and the agents' MCP tools accept the same routine from two
 * directions and have to refuse the same things for the same reasons - a
 * schedule that never fires, a zone `Intl` does not know, a model the
 * deployment does not offer. So the rules answer with a reason rather than
 * throwing: the routes wrap it in a 400, the tools hand it to the agent as text
 * it can correct and retry.
 */

export type Checked<T> = { ok: false; reason: string } | { ok: true; value: T };

/** Long enough for every IANA name, short enough to bound the column. */
export const TIMEZONE_MAX_LENGTH = 64;

export const NO_FUTURE_RUN = "This schedule has no future run.";

export const checkSchedule = (value: unknown): Checked<Schedule> => {
  const parsed = parseSchedule(value);
  return parsed.ok
    ? { ok: true, value: parsed.schedule }
    : { ok: false, reason: parsed.reason };
};

export const checkTimezone = (value: unknown): Checked<string> => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: '"timezone" is required.' };
  }
  const timezone = value.trim();
  if (timezone.length > TIMEZONE_MAX_LENGTH) {
    return {
      ok: false,
      reason: `"timezone" must be at most ${TIMEZONE_MAX_LENGTH} characters.`,
    };
  }
  if (!isValidTimeZone(timezone)) {
    return { ok: false, reason: `"${timezone}" is not a known time zone.` };
  }
  return { ok: true, value: timezone };
};

/**
 * A routine's model: `null` puts it back on whatever its agent runs on, and
 * anything else has to be a catalog id.
 */
export const checkModel = (value: unknown): Checked<string | null> => {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (!isAvailableModel(value)) {
    return {
      ok: false,
      reason: `"model" must be one of: ${AVAILABLE_MODEL_IDS}.`,
    };
  }
  return { ok: true, value };
};

/** A new routine has to have a firing ahead of it, or it is not a routine. */
export const firstRunAt = (
  schedule: Schedule,
  timezone: string,
  now: Date = new Date()
): Checked<Date> => {
  const next = nextRun(schedule, timezone, now);
  return next
    ? { ok: true, value: next }
    : { ok: false, reason: NO_FUTURE_RUN };
};

export interface ScheduleChange {
  enabled?: boolean;
  schedule?: Schedule;
  timezone?: string;
}

/**
 * Where an edit leaves `next_run_at`.
 *
 * Any of the three inputs can move the next firing, and an enabled routine must
 * have one - re-enabling a "once" that has been and gone is refused here rather
 * than saved as a routine that will never fire again. An edit that touches none
 * of them leaves the stored value exactly as it was.
 */
export const nextRunAfterChange = (
  routine: Routine,
  change: ScheduleChange,
  now: Date = new Date()
): Checked<Date | null> => {
  if (
    change.schedule === undefined &&
    change.timezone === undefined &&
    change.enabled === undefined
  ) {
    return { ok: true, value: routine.nextRunAt };
  }

  const willBeEnabled = change.enabled ?? routine.enabled;
  const effective = change.schedule ?? scheduleOf(routine);
  const nextRunAt =
    willBeEnabled && effective
      ? nextRun(effective, change.timezone ?? routine.timezone, now)
      : null;
  if (willBeEnabled && !nextRunAt) {
    return { ok: false, reason: NO_FUTURE_RUN };
  }
  return { ok: true, value: nextRunAt };
};
