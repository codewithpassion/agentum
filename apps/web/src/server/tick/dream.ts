// Dream lane tick jobs: keep every agent's dream trigger in step with its
// schedule, and start the dreams that are due.
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { TickJob } from "./registry.ts";

export const dreamJobs: readonly TickJob[] = [
  {
    name: "dream.sync",
    run: ({ services }) => services.dream.syncTriggers(SYSTEM_PRINCIPAL),
  },
  {
    name: "dream.fire",
    run: ({ services }) => services.dream.fireDue(SYSTEM_PRINCIPAL),
  },
  {
    name: "dream.fireTeams",
    run: ({ services }) => services.dream.fireDueTeams(SYSTEM_PRINCIPAL),
  },
];
