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

/** `runs.claimed_by` of a run that Managed Agents is working on. */
export const MANAGED_CLAIMER = "managed";

/**
 * How long a managed run's lease lasts after a claim or a heartbeat. The
 * poller's alarm heartbeats every few seconds, but the object can be down for
 * a while (a deploy, an eviction, a platform fault) while Anthropic keeps
 * working, and the session token dies with the lease. Like a cloud run's lease
 * (`cloud/lease.ts`), this one outlasts such an outage: the poller picks the
 * run up again when it is back, and an outage longer than this still ends the
 * run `interrupted`.
 */
export const MANAGED_LEASE_MS = 10 * 60_000;
