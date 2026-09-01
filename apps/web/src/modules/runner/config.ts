/** The Cloudflare runtime's dials. */

/**
 * Model calls one wake may spend before the run is stopped. The managed
 * runtime has a dollar budget per session; this runtime has no price list to
 * count against, so the cap is on calls. A stop here is reported like a
 * budget stop: the session is retired and the thread is told.
 */
export const MAX_MODEL_CALLS_PER_WAKE = 40;

/**
 * Steps one alarm invocation runs before re-arming itself. Short on purpose:
 * each invocation is bounded, and a message sent into the run or a stop lands
 * between invocations rather than after the whole task.
 */
export const STEPS_PER_ALARM = 6;

/** Output cap per model call; tool-using turns are short, answers are too. */
export const MAX_OUTPUT_TOKENS = 4096;

/** A failed model call is retried this many times before the run is failed. */
export const MAX_CONSECUTIVE_FAILURES = 2;
export const RETRY_DELAY_MS = 5000;
