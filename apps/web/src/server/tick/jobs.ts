// Every job the minute tick runs. Lanes edit their own file, never this one.
import { a2aJobs } from "./a2a.ts";
import { a2aTaskJobs } from "./a2a-tasks.ts";
import { accessJobs } from "./access.ts";
import { artifactJobs } from "./artifacts.ts";
import { automationJobs } from "./automation.ts";
import { discussionJobs } from "./discussions.ts";
import { dreamJobs } from "./dream.ts";
import { libraryJobs } from "./library.ts";
import type { TickJob } from "./registry.ts";
import { runtimeJobs } from "./runtime.ts";
import { slackJobs } from "./slack.ts";
import { spendJobs } from "./spend.ts";

export const tickJobs: readonly TickJob[] = [
  ...runtimeJobs,
  ...discussionJobs,
  ...a2aTaskJobs,
  ...a2aJobs,
  ...accessJobs,
  ...automationJobs,
  ...dreamJobs,
  ...libraryJobs,
  ...artifactJobs,
  ...spendJobs,
  ...slackJobs,
];
