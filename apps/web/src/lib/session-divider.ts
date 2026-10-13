import { isSessionStartMessage } from "#/modules/messaging/session-origin";

/** How long after a reset the DM header keeps its "New session" badge. */
export const NEW_SESSION_BADGE_MS = 5 * 60 * 1000;

/**
 * Which messages of a channel to draw. Everything stays loaded; the stretch
 * before the latest session divider is hidden until the reader asks for it.
 * A run of dividers (a channel `/clear` posts one per agent) stays together.
 */
export const visibleFromLatestDivider = <T extends { origin: string }>(
  messages: readonly T[],
  expanded: boolean
): { hiddenCount: number; visible: T[] } => {
  const latest = messages.findLastIndex(isSessionStartMessage);
  if (expanded || latest <= 0) {
    return { hiddenCount: 0, visible: [...messages] };
  }
  let start = latest;
  while (start > 0 && isSessionStartMessage(messages[start - 1] as T)) {
    start -= 1;
  }
  return { hiddenCount: start, visible: messages.slice(start) };
};

/**
 * When the newest divider in a DM was posted, if that is recent enough to call
 * the session new. Null once the window has passed, so the caller can stop re-rendering.
 */
export const newSessionBadge = (
  messages: readonly { createdAt: number; origin: string }[],
  now: number
): number | null => {
  const latest = messages.findLast(isSessionStartMessage);
  return latest && now - latest.createdAt < NEW_SESSION_BADGE_MS
    ? latest.createdAt
    : null;
};

/** The parsed `/clear` line: `agentName` is null when no agent was named. */
export interface ClearCommand {
  agentName: string | null;
}

const CLEAR_PATTERN = /^\/clear(?:\s+@?(.+))?$/i;

/** `/clear` or `/clear @Name`; anything else is an ordinary message. */
export const parseClearCommand = (body: string): ClearCommand | null => {
  const match = CLEAR_PATTERN.exec(body.trim());
  if (!match) {
    return null;
  }
  return { agentName: match[1]?.trim() || null };
};
