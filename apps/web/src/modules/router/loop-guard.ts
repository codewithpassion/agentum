import type { AuthorType } from "#/modules/messaging/service";
import { AGENT_STREAK_LIMIT, WAKE_LIMIT, WAKE_LIMIT_WINDOW_MS } from "./config";

/**
 * The two brakes on runaway agent chatter.
 *
 * Per channel: once N messages in a row are agent-authored, nobody is woken
 * there again until a human says something. Two agents can still talk, but only
 * for a bounded number of turns.
 *
 * Per agent: a sliding-window wake budget, so one busy channel cannot burn an
 * agent's whole rate limit.
 */

export interface ChannelGuard {
  /** Consecutive agent-authored messages seen in this channel. */
  agentStreak: number;
  suppressed: boolean;
}

export const emptyChannelGuard = (): ChannelGuard => ({
  agentStreak: 0,
  suppressed: false,
});

export const nextChannelGuard = (
  guard: ChannelGuard,
  authorType: AuthorType,
  limit: number = AGENT_STREAK_LIMIT
): ChannelGuard => {
  if (authorType !== "agent") {
    // A human (or an external surface) is back in the loop: reopen the channel.
    return { agentStreak: 0, suppressed: false };
  }
  const agentStreak = guard.agentStreak + 1;
  return { agentStreak, suppressed: agentStreak >= limit };
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
