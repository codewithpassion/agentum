// One run per agent at a time, on this machine. An offer waits in its agent's
// queue until the agent's slot is free, then the manager claims the run and
// executes it. The slot is released when the execution has finished, which is
// after Claude Code exited and the completion was posted. Offers for different
// agents run side by side.

import type { ClaimResponse, Offer } from "@repo/protocol/machine";
import type { RunExecution } from "./executor.ts";
import type { Logger } from "./log.ts";

export interface RunManagerOptions {
  /** Claims the run on the Worker. Rejects when the run cannot be claimed. */
  claim: (runId: string) => Promise<ClaimResponse>;
  /** Starts the claimed run. */
  execute: (claim: ClaimResponse) => RunExecution;
  log: Logger;
}

export interface RunManager {
  /** Aborts every running run and forgets the queued offers. */
  abortAll: (reason: string) => void;
  /** Aborts the run when it is running, or drops it from the queue. */
  cancel: (runId: string) => void;
  /** Resolves when no run is running or being claimed. */
  idle: () => Promise<void>;
  offer: (frame: Pick<Offer, "agentId" | "runId">) => void;
  /** Like abortAll, and every later offer is refused: the daemon is going down. */
  stop: (reason: string) => void;
}

interface Slot {
  execution: RunExecution | null;
  runId: string;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createRunManager = (options: RunManagerOptions): RunManager => {
  const { claim, execute, log } = options;
  const queues = new Map<string, string[]>();
  const slots = new Map<string, Slot>();
  const settled = new Set<Promise<void>>();
  // A cancel or an abort that arrives while the claim is in flight.
  const abortedBeforeStart = new Map<string, string>();
  let stopped = false;

  const isKnown = (runId: string): boolean =>
    [...slots.values()].some((slot) => slot.runId === runId) ||
    [...queues.values()].some((queue) => queue.includes(runId));

  const pump = (agentId: string): void => {
    if (slots.has(agentId)) {
      return;
    }
    const runId = queues.get(agentId)?.shift();
    if (runId === undefined) {
      queues.delete(agentId);
      return;
    }
    const slot: Slot = { execution: null, runId };
    slots.set(agentId, slot);
    const done = run(agentId, slot).finally(() => {
      slots.delete(agentId);
      settled.delete(done);
      pump(agentId);
    });
    settled.add(done);
  };

  const run = async (agentId: string, slot: Slot): Promise<void> => {
    let claimed: ClaimResponse;
    try {
      claimed = await claim(slot.runId);
    } catch (error) {
      log.error(`could not claim run ${slot.runId}: ${messageOf(error)}`);
      abortedBeforeStart.delete(slot.runId);
      return;
    }
    const execution = execute(claimed);
    slot.execution = execution;
    const reason = abortedBeforeStart.get(slot.runId);
    if (reason !== undefined) {
      abortedBeforeStart.delete(slot.runId);
      execution.abort(reason);
    }
    log.info(`run ${slot.runId} started for agent ${agentId}`);
    await execution.finished;
  };

  const offer: RunManager["offer"] = ({ agentId, runId }) => {
    if (stopped) {
      log.info(`not starting run ${runId}: the daemon is stopping`);
      return;
    }
    if (isKnown(runId)) {
      log.info(`ignoring a repeated offer for run ${runId}`);
      return;
    }
    const queue = queues.get(agentId) ?? [];
    queue.push(runId);
    queues.set(agentId, queue);
    pump(agentId);
  };

  const cancel: RunManager["cancel"] = (runId) => {
    for (const slot of slots.values()) {
      if (slot.runId === runId) {
        if (slot.execution === null) {
          abortedBeforeStart.set(runId, "cancelled by the relay");
        } else {
          slot.execution.abort("cancelled by the relay");
        }
        return;
      }
    }
    for (const queue of queues.values()) {
      const index = queue.indexOf(runId);
      if (index !== -1) {
        queue.splice(index, 1);
      }
    }
  };

  const abortAll: RunManager["abortAll"] = (reason) => {
    queues.clear();
    for (const slot of slots.values()) {
      if (slot.execution === null) {
        abortedBeforeStart.set(slot.runId, reason);
      } else {
        slot.execution.abort(reason);
      }
    }
  };

  const stop: RunManager["stop"] = (reason) => {
    stopped = true;
    abortAll(reason);
  };

  const idle = async (): Promise<void> => {
    if (settled.size === 0) {
      return;
    }
    await Promise.all([...settled]);
    // A released slot may have started the next queued run.
    await idle();
  };

  return { abortAll, cancel, idle, offer, stop };
};
