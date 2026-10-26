// Runtime lane tick jobs: the queued-run sweep and the lease reaper (M0.4).
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { TickJob } from "./registry.ts";

export const runtimeJobs: readonly TickJob[] = [
  {
    name: "runs.sweep",
    run: ({ services }) => services.runs.sweepQueuedRuns(SYSTEM_PRINCIPAL),
  },
  {
    name: "runs.reap",
    run: ({ services }) => services.runs.reapExpiredLeases(SYSTEM_PRINCIPAL),
  },
  {
    name: "requests.expire",
    run: ({ services }) => services.requests.expireDue(SYSTEM_PRINCIPAL),
  },
  {
    name: "mail.provision-pending",
    run: ({ services }) => services.mail.provisionPending(SYSTEM_PRINCIPAL),
  },
  {
    name: "managed.rearm",
    run: ({ services }) => services.managed.rearm(),
  },
  {
    name: "slack.purge-seen",
    run: ({ services }) => services.slack.purgeSeen(),
  },
  {
    name: "slack.batches",
    run: ({ services }) => services.slack.runDueBatches(),
  },
];
