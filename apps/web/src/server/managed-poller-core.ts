// The logic of one managed run's poller, kept free of `cloudflare:workers` so
// bun can test it with fake storage and a fake clock. `managed-poller.ts` wraps
// it in the Durable Object. The poller is only a timer: it wakes the run's
// step on an alarm and re-arms itself until the step says the run is finished.
import type { ManagedStepResult } from "@repo/services/managed/types";

/** How long to wait before trying a step again after it threw. */
export const RETRY_MS = 10_000;

const RUN_ID_KEY = "runId";

/** The part of `DurableObjectStorage` the poller uses. */
export interface PollerStorage {
  delete: (key: string) => Promise<unknown>;
  deleteAlarm: () => Promise<void>;
  get: <T>(key: string) => Promise<T | undefined>;
  getAlarm: () => Promise<number | null>;
  put: <T>(key: string, value: T) => Promise<void>;
  setAlarm: (at: number) => Promise<void>;
}

export interface PollerCoreDeps {
  /** Tells Anthropic to stop the run's session. */
  interrupt: (runId: string) => Promise<void>;
  /** Epoch milliseconds. */
  now: () => number;
  /** One poll of the run. `next` is the wait before the next poll, or null when the run is finished. */
  step: (runId: string) => Promise<ManagedStepResult>;
  storage: PollerStorage;
}

const logFailure = (what: string, error: unknown) => {
  console.error(`ManagedPoller: ${what} failed`, error);
};

export const createPollerCore = ({
  interrupt,
  now,
  step,
  storage,
}: PollerCoreDeps) => {
  /** Polls the run now. An alarm already due sooner stays; a later one moves up. */
  const kick = async (runId: string): Promise<void> => {
    await storage.put(RUN_ID_KEY, runId);
    const pending = await storage.getAlarm();
    const at = now();
    if (pending === null || pending > at) {
      await storage.setAlarm(at);
    }
  };

  const alarm = async (): Promise<void> => {
    const runId = await storage.get<string>(RUN_ID_KEY);
    if (runId === undefined) {
      return;
    }
    let next: number | null;
    try {
      ({ next } = await step(runId));
    } catch (error) {
      logFailure("step", error);
      await storage.setAlarm(now() + RETRY_MS);
      return;
    }
    if (next === null) {
      await storage.deleteAlarm();
      await storage.delete(RUN_ID_KEY);
      return;
    }
    await storage.setAlarm(now() + next);
  };

  /** Stops the run's polling and tells Anthropic to stop its session. */
  const cancel = async (runId: string): Promise<void> => {
    try {
      await interrupt(runId);
    } catch (error) {
      logFailure("interrupting the run", error);
    }
    await storage.deleteAlarm();
    await storage.delete(RUN_ID_KEY);
  };

  return { alarm, cancel, kick };
};

export type PollerCore = ReturnType<typeof createPollerCore>;
