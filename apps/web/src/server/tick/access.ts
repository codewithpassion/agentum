// Access lane tick jobs. The lane adds its jobs here and nowhere else.
import type { TickJob } from "./registry.ts";

export const accessJobs: readonly TickJob[] = [];
