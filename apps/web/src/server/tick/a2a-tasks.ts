// Inbound A2A task tick jobs. The sweep catches what the run events missed.
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { TickJob } from "./registry.ts";

export const a2aTaskJobs: readonly TickJob[] = [
  {
    name: "a2a.tasks-sweep",
    run: ({ services }) => services.a2aTasks.sweep(SYSTEM_PRINCIPAL),
  },
];
