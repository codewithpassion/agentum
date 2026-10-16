/**
 * The two brakes on runaway agent chatter.
 *
 * Per thread: once the most recent posts are all agent-authored, nobody is
 * woken there again until a human posts.
 *
 * Per agent: a sliding-window wake budget, so one busy thread cannot burn an
 * agent's whole rate limit.
 */

export const AGENT_STREAK_LIMIT = 3;
export const WAKE_LIMIT = 10;
export const WAKE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * True when the first `limit` entries (newest first) all exist and are agent
 * posts. Fewer entries than `limit` means not suppressed.
 */
export const streakSuppressed = (
  authorKinds: readonly ("user" | "agent")[],
  limit: number = AGENT_STREAK_LIMIT
): boolean => {
  if (authorKinds.length < limit) {
    return false;
  }
  return authorKinds.slice(0, limit).every((kind) => kind === "agent");
};

export interface RateCheck {
  allowed: boolean;
  /** The window to store back, with this wake counted when it was allowed. */
  timestamps: number[];
}

export const checkWakeRate = (
  timestamps: readonly number[],
  now: number,
  options: { limit?: number; windowMs?: number } = {}
): RateCheck => {
  const limit = options.limit ?? WAKE_LIMIT;
  const windowMs = options.windowMs ?? WAKE_LIMIT_WINDOW_MS;
  const recent = timestamps.filter((at) => now - at < windowMs);

  if (recent.length >= limit) {
    return { allowed: false, timestamps: recent };
  }
  return { allowed: true, timestamps: [...recent, now] };
};
