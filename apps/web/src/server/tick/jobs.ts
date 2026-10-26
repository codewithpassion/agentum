// Every job the minute tick runs. Lanes edit their own file, never this one.
import { accessJobs } from "./access.ts";
import { automationJobs } from "./automation.ts";
import { libraryJobs } from "./library.ts";
import type { TickJob } from "./registry.ts";
import { runtimeJobs } from "./runtime.ts";

export const tickJobs: readonly TickJob[] = [
  ...runtimeJobs,
  ...accessJobs,
  ...automationJobs,
  ...libraryJobs,
];
