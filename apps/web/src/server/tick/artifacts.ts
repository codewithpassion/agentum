// Artifact share tick jobs. The artifacts lane adds its jobs here and nowhere else.
import type { TickJob } from "./registry.ts";

export const artifactJobs: readonly TickJob[] = [
  {
    name: "artifacts.prune",
    // Once a day, at 03:17 UTC.
    run: ({ clock, services }) => {
      const now = clock.now();
      return now.getUTCHours() === 3 && now.getUTCMinutes() === 17
        ? services.artifactShares.prune()
        : Promise.resolve();
    },
  },
];
