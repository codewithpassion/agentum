// Spend lane tick job: lift cap pauses once their week has rolled over.
import type { TickJob } from "./registry.ts";

export const spendJobs: readonly TickJob[] = [
  {
    name: "spend.liftCapPauses",
    run: ({ services }) => services.spend.liftCapPauses(),
  },
];
