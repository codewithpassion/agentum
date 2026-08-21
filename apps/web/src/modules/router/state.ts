import type { SessionStatus } from "#/modules/anthropic/events";
import type { WakeTarget } from "./wake-decision";
import type { WakeEntry } from "./wake-text";

/** Everything the router keeps in Durable Object storage, and its key layout. */

export interface StoredSession {
  /** The channel whose message woke this session - where "typing…" is shown. */
  channelId: string;
  cursorAt: string | null;
  cursorId: string | null;
  lastActivityAt: number;
  /**
   * The model this session was created with. Absent on a session stored before
   * models were configurable, which counts as the workspace default - the wake
   * path compares against it and starts a fresh session when they differ.
   */
  model?: string;
  sessionId: string;
  status: SessionStatus;
  /**
   * The thread the waking message was in, when it was in one. Kept so a session
   * that ends without answering can take back the "Thinking…" it left there.
   */
  threadParentId?: string | null;
}

export interface QueuedWake {
  agentId: string;
  /** The channel to attribute the wake to, for status broadcasts. */
  channelId: string;
  enqueuedAt: number;
  entries: WakeEntry[];
}

export interface PendingNotification {
  entry: WakeEntry;
  targets: WakeTarget[];
  /**
   * The thread reply's own text and author, kept only for a `consider` target:
   * deciding whether it was meant for an agent needs the message itself, and
   * `WakeEntry` has already been shaped for what an agent reads.
   */
  threadMessage?: { authorName: string; body: string };
}

export const SESSION_KEY_PREFIX = "session:";
export const SESSION_KEY = (agentId: string) =>
  `${SESSION_KEY_PREFIX}${agentId}`;
export const DIGEST_KEY = (agentId: string) => `digest:${agentId}`;
export const RATE_KEY = (agentId: string) => `rate:${agentId}`;
export const GUARD_KEY = (channelId: string) => `guard:${channelId}`;

/**
 * A thread an agent is currently showing a "Thinking…" indicator in. Keyed by
 * both, not just the agent: one session can be woken for two threads before it
 * answers either, and a single key would lose the first indicator with no way
 * left to take it down.
 */
export const THINKING_KEY_PREFIX = (agentId: string) => `thinking:${agentId}:`;
export const THINKING_KEY = (agentId: string, threadParentId: string) =>
  `${THINKING_KEY_PREFIX(agentId)}${threadParentId}`;
export const PENDING_KEY = "pending";
export const QUEUE_KEY = "queue";
export const NEXT_DIGEST_KEY = "nextDigestAt";
/**
 * The workspace this instance routes for, learned from the first notification
 * it is handed. A Durable Object cannot read back the name it was addressed
 * with, so the tenant has to arrive with the traffic - see `AgentRouter`.
 */
export const WORKSPACE_KEY = "workspaceId";
