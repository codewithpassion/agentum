/** The services' view of the poller: one Durable Object per managed run, by run id. */
export interface ManagedPollerPort {
  /** Stops polling the run and tells Anthropic to stop its session. Best effort. */
  cancel: (runId: string) => Promise<void>;
  /** Starts polling the run now, unless it is already being polled. */
  kick: (runId: string) => Promise<void>;
}

/** What one poll step decided: wait this many milliseconds, or stop (null). */
export interface ManagedStepResult {
  next: number | null;
}
