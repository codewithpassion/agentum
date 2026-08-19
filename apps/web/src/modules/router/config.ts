/**
 * The router's dials. All of them exist to keep two things bounded: how often
 * an agent may be woken, and how much can be running at once.
 */

/** How long un-mentioned channel members wait before a batched wake. */
export const DIGEST_INTERVAL_MS = 5 * 60 * 1000;

/** Anthropic caps concurrent environments at 5, so 5 sessions may run at once. */
export const MAX_ACTIVE_SESSIONS = 5;

/** A session older than this is not worth resuming; the next wake starts fresh. */
export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;

/** How often live sessions are polled for events while any is running. */
export const PUMP_INTERVAL_MS = 4000;

/**
 * Consecutive agent-authored messages in a channel before wakes are suppressed
 * there. Only a human (or an external surface) can clear it.
 */
export const AGENT_STREAK_LIMIT = 8;

/** Per-agent wake budget, counted over a sliding window. */
export const WAKE_LIMIT = 10;
export const WAKE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

/** Nothing older than this stays in a digest; it would be stale by then. */
export const DIGEST_MAX_ENTRIES = 50;
