import { MAX_ACTIVE_SESSIONS } from "./config";
import type { WakeTarget } from "./wake-decision";

/**
 * Turns "these agents should hear about this message" into "and here is what
 * actually happens to each of them", given the channel's loop guard, each
 * agent's rate budget, and how many sessions are already running.
 *
 * Pure, and the single place the queue's admission rule lives.
 */

export type WakeAction =
  /** Send into the agent's live session, or start one now. */
  | "wake"
  /** No session slot free: FIFO until one opens. */
  | "queue"
  /** Batched into the next digest instead (a digest target, or rate-limited). */
  | "digest"
  /** The channel is in an agent-only loop; nothing is woken until a human posts. */
  | "suppressed";

export interface PlannedWake {
  action: WakeAction;
  agentId: string;
}

export interface PlanInput {
  /** Sessions currently running, across all agents. */
  activeSessions: number;
  /** Whether the agent already holds a session we can send into. */
  hasLiveSession: (agentId: string) => boolean;
  /** Whether the agent's wake budget still has room. */
  isWithinRate: (agentId: string) => boolean;
  maxActiveSessions?: number;
  /** The channel's loop guard is closed. */
  suppressed: boolean;
  targets: readonly WakeTarget[];
}

export const planWakes = (input: PlanInput): PlannedWake[] => {
  const max = input.maxActiveSessions ?? MAX_ACTIVE_SESSIONS;
  let active = input.activeSessions;
  const planned: PlannedWake[] = [];

  for (const target of input.targets) {
    if (input.suppressed) {
      planned.push({ action: "suppressed", agentId: target.agentId });
      continue;
    }
    if (target.kind === "digest") {
      planned.push({ action: "digest", agentId: target.agentId });
      continue;
    }
    if (!input.isWithinRate(target.agentId)) {
      // A rate-limited mention is deferred, never dropped: the agent still
      // hears about it, just in the next digest.
      planned.push({ action: "digest", agentId: target.agentId });
      continue;
    }
    if (input.hasLiveSession(target.agentId)) {
      // Sending into a running session costs no new slot.
      planned.push({ action: "wake", agentId: target.agentId });
      continue;
    }
    if (active >= max) {
      planned.push({ action: "queue", agentId: target.agentId });
      continue;
    }
    active += 1;
    planned.push({ action: "wake", agentId: target.agentId });
  }

  return planned;
};

/** How many queued wakes may start right now. */
export const freeSlots = (
  activeSessions: number,
  maxActiveSessions: number = MAX_ACTIVE_SESSIONS
): number => Math.max(0, maxActiveSessions - activeSessions);
