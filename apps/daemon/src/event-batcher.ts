// Queues run events, numbers them, and posts them to the relay in serial
// batches on a timer. A failed batch stays at the head of the queue and goes
// again on the next tick, unless the error is permanent and the batch is dropped.

import type { RunEventInput } from "@repo/protocol/machine";
import type { CancelFn, Timers } from "./client.ts";

export const BATCH_INTERVAL_MS = 500;
const MAX_BATCH_SIZE = 100;
const FIRST_SEQ = 1;
const CLIENT_ERROR_MIN_STATUS = 400;
const CLIENT_ERROR_MAX_STATUS = 499;
// Rate limiting and a request timeout clear up by themselves.
const RETRYABLE_CLIENT_STATUSES = new Set([408, 429]);

export interface EventBatcherOptions {
  /** True for an error that retrying cannot fix (the batch is dropped). Default: a RunApiError-like object whose numeric `status` is 400 to 499, except 408 and 429. */
  isPermanent?: (error: unknown) => boolean;
  /** Called with every failed send, after the batch has been kept or dropped. */
  onError: (error: unknown) => void;
  /** Posts one batch. Rejects with an error carrying the failure. */
  send: (events: RunEventInput[]) => Promise<void>;
  timers: Timers;
}

export interface EventBatcher {
  /** Sends everything queued, after any send already in flight. Resolves once the queue is empty or a send failed; never rejects. */
  flush: () => Promise<void>;
  /** Assigns the next seq (starting at 1) and queues the event. */
  push: (event: Pick<RunEventInput, "payload" | "type">) => void;
  /** Starts the 500 ms timer; every tick calls flush. */
  start: () => void;
  /** Cancels the timer. Does not flush. */
  stop: () => void;
}

const hasClientErrorStatus = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  typeof error.status === "number" &&
  error.status >= CLIENT_ERROR_MIN_STATUS &&
  error.status <= CLIENT_ERROR_MAX_STATUS &&
  !RETRYABLE_CLIENT_STATUSES.has(error.status);

export const createEventBatcher = (
  options: EventBatcherOptions
): EventBatcher => {
  const { send, timers, onError } = options;
  const isPermanent = options.isPermanent ?? hasClientErrorStatus;

  const queue: RunEventInput[] = [];
  let nextSeq = FIRST_SEQ;
  let tail: Promise<void> = Promise.resolve();
  let cancelTimer: CancelFn | null = null;

  const push = (event: Pick<RunEventInput, "payload" | "type">) => {
    queue.push({ payload: event.payload, seq: nextSeq, type: event.type });
    nextSeq += 1;
  };

  /** Sends the head batch. Returns true when it was posted. */
  const sendHead = async (): Promise<boolean> => {
    const batch = queue.slice(0, MAX_BATCH_SIZE);
    try {
      await send(batch);
    } catch (error) {
      if (isPermanent(error)) {
        queue.splice(0, batch.length);
      }
      onError(error);
      return false;
    }
    queue.splice(0, batch.length);
    return true;
  };

  const drain = async (): Promise<void> => {
    if (queue.length === 0) {
      return;
    }
    const sent = await sendHead();
    if (sent) {
      await drain();
    }
  };

  const flush = (): Promise<void> => {
    tail = tail.then(drain);
    return tail;
  };

  const start = () => {
    if (cancelTimer !== null) {
      return;
    }
    cancelTimer = timers.every(BATCH_INTERVAL_MS, () => flush(), "event-batch");
  };

  const stop = () => {
    cancelTimer?.();
    cancelTimer = null;
  };

  return { flush, push, start, stop };
};
