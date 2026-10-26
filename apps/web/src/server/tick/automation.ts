// Automation lane tick jobs. The lane adds its jobs here and nowhere else.
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { TickJob } from "./registry.ts";

/**
 * Unauthenticated GitHub allows 60 API requests an hour per IP, and Worker
 * egress IPs are shared. Two skills every fifth minute is about 24 calls an
 * hour: 576 skills a day, so each is checked about every 6 hours up to about
 * 140 sourced skills.
 */
export const GITHUB_UPDATE_BATCH = 2;
export const GITHUB_UPDATE_EVERY_MINUTES = 5;

export const automationJobs: readonly TickJob[] = [
  {
    name: "routines.fire",
    run: ({ services }) => services.routines.fireDue(SYSTEM_PRINCIPAL),
  },
  {
    name: "routines.settle",
    run: ({ services }) => services.routines.settleRuns(SYSTEM_PRINCIPAL),
  },
  {
    // The oldest `checked_at` first, so the batch walks through every sourced skill.
    name: "skills-github-updates",
    run: ({ clock, services }) =>
      clock.now().getUTCMinutes() % GITHUB_UPDATE_EVERY_MINUTES === 0
        ? services.skillsStore.checkUpdates(SYSTEM_PRINCIPAL, {
            limit: GITHUB_UPDATE_BATCH,
          })
        : Promise.resolve(null),
  },
];
