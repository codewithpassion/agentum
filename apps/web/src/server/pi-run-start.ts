// The start of a cloud run, kept free of `cloudflare:workers` so bun can test
// it. The Worker's request only hands a start to the Durable Object, which
// saves it. The claim and the slow setup (the VM's library, the agent's home)
// run later from an alarm, so a browser that leaves cannot cancel them, and a
// start cut short by an eviction is found in storage and tried again.
import type { CloudStart } from "@repo/services/cloud/types";
import type { RunStorage } from "./pi-run-core.ts";

/** How long an accepted run may take to start before it is failed. */
export const START_TIMEOUT_MS = 120_000;
/** The wait before a start that failed is tried again. */
export const START_RETRY_MS = 10_000;

const PENDING_KEY = "pending-starts";

/** A start the platform handed over and this object has not finished. */
interface PendingStart {
  /** The claim was tried, saved before the call: a retry that finds the run running knows the claim went through. */
  claimAttempted?: boolean;
  /** The run is ours: the claim went through, so a retry must not claim again. */
  claimed: boolean;
  input: CloudStart;
  /** When the first wake for this run arrived, from `now()`. */
  requestedAt: number;
}

export interface StartQueueDeps {
  /** Starts working the claimed run in Pi. */
  begin: (input: CloudStart) => Promise<void>;
  /**
   * Claims the run for the system. "conflict" when it cannot be claimed now,
   * "running" when it already is running (claimed by an earlier try, or begun
   * by an earlier wake).
   */
  claim: (runId: string) => Promise<"claimed" | "conflict" | "running">;
  /** Ends a claimed run as failed. */
  fail: (runId: string, error: string) => Promise<void>;
  now?: () => number;
  /** The environment and files the run needs before Pi can take it. */
  prepare: (input: CloudStart) => Promise<void>;
  storage: RunStorage;
  /** Whether the run still waits to be claimed (queued or offered). */
  waiting: (runId: string) => Promise<boolean>;
}

class DeadlineError extends Error {
  constructor() {
    super("setup did not finish in time");
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createStartQueue = ({
  begin,
  claim,
  fail,
  now = Date.now,
  prepare,
  storage,
  waiting,
}: StartQueueDeps) => {
  const load = async () =>
    (await storage.get<PendingStart[]>(PENDING_KEY)) ?? [];

  const save = async (pending: PendingStart[]) => {
    if (pending.length === 0) {
      await storage.delete(PENDING_KEY);
    } else {
      await storage.put(PENDING_KEY, pending);
    }
  };

  const remove = async (runId: string) => {
    await save((await load()).filter((entry) => entry.input.run.id !== runId));
  };

  /**
   * Saves a start. A repeat for the same run, such as the minute sweep
   * offering it again, brings the newer run token and keeps the rest.
   */
  const request = async (input: CloudStart): Promise<void> => {
    const pending = await load();
    const known = pending.find((entry) => entry.input.run.id === input.run.id);
    if (known) {
      known.input = input;
    } else {
      pending.push({ claimed: false, input, requestedAt: now() });
    }
    await save(pending);
  };

  /** Saves fields on a pending start. */
  const mark = async (runId: string, fields: Partial<PendingStart>) => {
    const pending = await load();
    const stored = pending.find((other) => other.input.run.id === runId);
    if (stored) {
      Object.assign(stored, fields);
      await save(pending);
    }
  };

  /** Fails a claimed run that could not start in time. A run nobody claimed is left offered, for the sweep. */
  const giveUp = async (entry: PendingStart, reason: string) => {
    const runId = entry.input.run.id;
    if (entry.claimed) {
      try {
        await fail(
          runId,
          `The run could not start within ${START_TIMEOUT_MS / 60_000} minutes: ${reason}`
        );
      } catch (error) {
        // Most likely the platform already ended the run (cancelled, or its lease expired).
        console.warn(
          `PiRun: failing run ${runId} that could not start: ${describe(error)}`
        );
      }
    }
    // After the failure is written, so an eviction in between finds the start and fails the run again.
    await remove(runId);
  };

  /** Runs one step of a start, but not past the time the run has left to start. */
  const withinDeadline = async (
    entry: PendingStart,
    step: () => Promise<void>
  ): Promise<void> => {
    const left = Math.max(START_TIMEOUT_MS - (now() - entry.requestedAt), 1000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineError()), left);
    });
    try {
      await Promise.race([step(), expired]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** One start: the claim, then the setup, then Pi. Resolves to whether it should be tried again. */
  const attempt = async (entry: PendingStart): Promise<boolean> => {
    const runId = entry.input.run.id;
    try {
      if (!entry.claimed) {
        // Before the marker: a run that is not waiting was begun by an earlier wake, and a late duplicate must leave it alone. Once the marker is set, a running run is ours.
        if (!(entry.claimAttempted || (await waiting(runId)))) {
          await remove(runId);
          return false;
        }
        await mark(runId, { claimAttempted: true });
        const outcome = await claim(runId);
        // A run that is running without a claim of ours is already begun by an earlier wake: leave it alone.
        const ours =
          outcome === "claimed" ||
          (outcome === "running" && entry.claimAttempted === true);
        if (!ours) {
          // Another run holds the agent, or the run is over. The platform offers it again when it can run.
          await remove(runId);
          return false;
        }
        entry.claimed = true;
        await mark(runId, { claimed: true });
      }
      await withinDeadline(entry, () => prepare(entry.input));
      await withinDeadline(entry, () => begin(entry.input));
      await remove(runId);
      return false;
    } catch (error) {
      console.error(`PiRun: starting run ${runId}: ${describe(error)}`);
      // A step that hit its deadline ends the start even if the clock has not moved as far.
      if (
        now() - entry.requestedAt >= START_TIMEOUT_MS ||
        error instanceof DeadlineError
      ) {
        await giveUp(entry, describe(error));
        return false;
      }
      return true;
    }
  };

  /**
   * Works every saved start, including ones saved while it runs. Resolves to
   * whether any must be tried again later.
   */
  const work = async (): Promise<boolean> => {
    const tried = new Set<string>();
    let again = false;
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: a session's starts run one after the other
      const next = (await load()).find(
        (entry) => !tried.has(entry.input.run.id)
      );
      if (!next) {
        return again;
      }
      tried.add(next.input.run.id);
      if (await attempt(next)) {
        again = true;
      }
    }
  };

  const hasPending = async () => (await load()).length > 0;

  return { hasPending, request, work };
};

export type StartQueue = ReturnType<typeof createStartQueue>;
