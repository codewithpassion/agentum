/**
 * How long a cloud run's lease lasts after a claim or a heartbeat. A machine
 * run uses 90 seconds, because its daemon heartbeats from a live process. A
 * cloud run's Durable Object can be down for a while (a deploy, an eviction, a
 * platform fault) and a run token dies with the lease, so the lease outlasts
 * such an outage. The object's alarm heartbeats far more often than this, and
 * an outage longer than the lease still ends the run `interrupted`.
 */
export const CLOUD_LEASE_MS = 10 * 60_000;
