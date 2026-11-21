// Slack lane tick jobs: finish the room work a lost `waitUntil` left undone.
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { TickJob } from "./registry.ts";

export const slackJobs: readonly TickJob[] = [
  {
    name: "slack.roomSweep",
    run: ({ services }) => services.slackRoomSweep.sweep(SYSTEM_PRINCIPAL),
  },
];
