// What the session is doing, read from its live events: which run works, which
// messages wait behind it, and which waiting messages were removed. The task
// page's run list is a snapshot from when it loaded, so a message sent while a
// run works would not show in it.

import type { ThreadMessage } from "@repo/protocol/thread";

interface RunEvent {
  runId: string | null;
  type: string;
}

type RunPhase = "queued" | "live" | "ended";

export interface ThreadActivity {
  /** Runs waiting for their turn, oldest first. */
  queued: readonly string[];
  /** Runs removed before they started. Their messages leave the conversation. */
  removed: ReadonlySet<string>;
  /** The latest run that has started and not ended, or null. */
  working: string | null;
}

const STARTED = new Set(["run.started", "run.resumed", "run.waiting"]);
const ENDED = new Set([
  "run.finished",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
]);

export function threadActivity(events: readonly RunEvent[]): ThreadActivity {
  const phases = new Map<string, RunPhase>();
  const started = new Set<string>();
  const removed = new Set<string>();
  for (const { runId, type } of events) {
    if (runId === null) {
      continue;
    }
    if (type === "run.queued" && !phases.has(runId)) {
      phases.set(runId, "queued");
    } else if (STARTED.has(type)) {
      started.add(runId);
      phases.set(runId, "live");
    } else if (ENDED.has(type)) {
      phases.set(runId, "ended");
      if (type === "run.cancelled" && !started.has(runId)) {
        removed.add(runId);
      }
    }
  }
  const ids = [...phases.keys()];
  return {
    queued: ids.filter((id) => phases.get(id) === "queued"),
    removed,
    working: ids.findLast((id) => phases.get(id) === "live") ?? null,
  };
}

/**
 * The user messages that wait behind work: message id to the run that will
 * carry it. With nothing working, the oldest queued run is about to start, so
 * only the ones behind it wait.
 */
export function waitingMessages(
  messages: readonly Pick<ThreadMessage, "id" | "role" | "runId" | "steered">[],
  activity: ThreadActivity
): Map<string, string> {
  const behind =
    activity.working === null ? activity.queued.slice(1) : activity.queued;
  const waiting = new Map<string, string>();
  for (const message of messages) {
    if (
      message.role === "user" &&
      message.steered !== true &&
      message.runId !== null &&
      behind.includes(message.runId)
    ) {
      waiting.set(message.id, message.runId);
    }
  }
  return waiting;
}

/**
 * The messages to draw. A run that waits behind work has not started, so its
 * empty assistant turn would show a second "Working" spinner. Only the waiting
 * user message stays, with its Remove button.
 */
export function withoutWaitingTurns<
  T extends Pick<ThreadMessage, "role" | "runId">,
>(messages: readonly T[], waiting: ReadonlyMap<string, string>): T[] {
  const runIds = new Set(waiting.values());
  return messages.filter(
    (message) =>
      !(
        message.role === "assistant" &&
        message.runId !== null &&
        runIds.has(message.runId)
      )
  );
}
