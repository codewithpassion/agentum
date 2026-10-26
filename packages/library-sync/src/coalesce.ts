/** A clock supplied by the caller, so batching can be tested without real time. */
export interface CoalescerClock<Handle = ReturnType<typeof setTimeout>> {
  clearTimeout: (handle: Handle) => void;
  setTimeout: (fn: () => void, ms: number) => Handle;
}

export interface CoalescerOptions<Handle = ReturnType<typeof setTimeout>> {
  clock?: CoalescerClock<Handle>;
  maxMs?: number;
  onBatch: (paths: string[]) => void | Promise<void>;
  onError?: (error: unknown) => void;
  quietMs?: number;
}

export interface Coalescer {
  add: (path: string) => void;
  cancel: () => void;
  flush: () => void;
}

const systemClock: CoalescerClock = {
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
};

/** Hands over each sorted batch after quiet time, or at the maximum batch age. */
const withClock = <Handle>({
  clock,
  maxMs = 5000,
  onBatch,
  onError = () => undefined,
  quietMs = 1500,
}: CoalescerOptions<Handle> & { clock: CoalescerClock<Handle> }): Coalescer => {
  const pending = new Set<string>();
  let quiet: { handle: Handle } | undefined;
  let max: { handle: Handle } | undefined;

  const cancel = () => {
    if (quiet) {
      clock.clearTimeout(quiet.handle);
    }
    if (max) {
      clock.clearTimeout(max.handle);
    }
    quiet = undefined;
    max = undefined;
    pending.clear();
  };

  const report = (error: unknown) => {
    // Error reporting must not create another unhandled rejection.
    try {
      onError(error);
    } catch {
      // A reporting failure does not stop later batches.
    }
  };

  const flush = () => {
    const paths = [...pending].sort();
    cancel();
    if (paths.length === 0) {
      return;
    }
    try {
      Promise.resolve(onBatch(paths)).catch(report);
    } catch (error) {
      report(error);
    }
  };

  return {
    add: (path) => {
      pending.add(path);
      if (quiet) {
        clock.clearTimeout(quiet.handle);
      }
      if (!max) {
        max = { handle: clock.setTimeout(flush, maxMs) };
      }
      quiet = { handle: clock.setTimeout(flush, quietMs) };
    },
    cancel,
    flush,
  };
};

export const createCoalescer = <Handle = ReturnType<typeof setTimeout>>(
  options: CoalescerOptions<Handle>
): Coalescer =>
  options.clock
    ? withClock({ ...options, clock: options.clock })
    : withClock({ ...options, clock: systemClock });
