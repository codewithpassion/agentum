// Library lane tick jobs. The lane adds its jobs here and nowhere else.
import type { TickJob } from "./registry.ts";

export const libraryJobs: readonly TickJob[] = [
  {
    name: "library.prune-versions",
    run: ({ clock, services }) => services.library.pruneVersions(clock.now()),
  },
];
