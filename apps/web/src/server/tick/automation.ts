// Automation lane tick jobs. The lane adds its jobs here and nowhere else.
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { TickJob } from "./registry.ts";

export const automationJobs: readonly TickJob[] = [
  {
    name: "routines.fire",
    run: ({ services }) => services.routines.fireDue(SYSTEM_PRINCIPAL),
  },
  {
    name: "routines.settle",
    run: ({ services }) => services.routines.settleRuns(SYSTEM_PRINCIPAL),
  },
];
