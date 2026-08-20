import type { SessionStatus } from "#/modules/anthropic/events";
import type { WakeEntry } from "./wake-text";

/** Everything the router keeps in Durable Object storage, and its key layout. */

export interface StoredSession {
  /** The channel whose message woke this session - where "working…" is shown. */
  channelId: string;
  cursorAt: string | null;
  cursorId: string | null;
  lastActivityAt: number;
  sessionId: string;
  status: SessionStatus;
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
  targets: { agentId: string; kind: "immediate" | "digest" }[];
}

export const SESSION_KEY_PREFIX = "session:";
export const SESSION_KEY = (agentId: string) =>
  `${SESSION_KEY_PREFIX}${agentId}`;
export const DIGEST_KEY = (agentId: string) => `digest:${agentId}`;
export const RATE_KEY = (agentId: string) => `rate:${agentId}`;
export const GUARD_KEY = (channelId: string) => `guard:${channelId}`;
export const PENDING_KEY = "pending";
export const QUEUE_KEY = "queue";
export const NEXT_DIGEST_KEY = "nextDigestAt";
/**
 * The workspace this instance routes for, learned from the first notification
 * it is handed. A Durable Object cannot read back the name it was addressed
 * with, so the tenant has to arrive with the traffic - see `AgentRouter`.
 */
export const WORKSPACE_KEY = "workspaceId";
