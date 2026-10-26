// Library lane tick jobs. The lane adds its jobs here and nowhere else.
import type { TickJob } from "./registry.ts";

export const libraryJobs: readonly TickJob[] = [
  {
    name: "library.prune-versions",
    // Hourly, on the hour (UTC): the retention windows are days long.
    run: ({ clock, services }) => {
      const now = clock.now();
      return now.getUTCMinutes() === 0
        ? services.library.pruneVersions(now)
        : Promise.resolve();
    },
  },
];
