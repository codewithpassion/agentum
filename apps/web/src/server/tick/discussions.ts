import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { TickJob } from "./registry.ts";

export const discussionJobs: readonly TickJob[] = [
  {
    name: "inbox.discussions",
    run: ({ services }) => services.inbox.sweepDiscussions(SYSTEM_PRINCIPAL),
  },
];
