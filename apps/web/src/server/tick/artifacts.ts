import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
// Artifact share tick jobs. The artifacts lane adds its jobs here and nowhere else.
import type { TickJob } from "./registry.ts";

export const artifactJobs: readonly TickJob[] = [
  {
    name: "artifacts.live-checkpoints",
    run: async ({ services }) => {
      if (!services.liveArtifacts) {
        return;
      }
      let cursor: string | undefined;
      do {
        // biome-ignore lint/performance/noAwaitInLoops: scheduled fallback follows the persisted artifact cursor.
        const page = await services.liveArtifacts.retryCheckpoints(
          SYSTEM_PRINCIPAL,
          { cursor, limit: 100 }
        );
        cursor = page.next;
      } while (cursor);
    },
  },
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
