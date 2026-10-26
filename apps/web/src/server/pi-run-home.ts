// The agent's library home in an isolate run. A dry run writes nothing to the
// library, so it neither makes the home nor needs it: a missing home reads as empty.
import { isServiceError } from "@repo/services/errors";
import {
  agentHomePath,
  ensureAgentHome,
  type HomeOps,
} from "@repo/services/library/home";
import type { LibraryOps } from "./library-bash/library-fs.ts";

/** Makes the agent's home when it is missing. A dry run leaves the library alone. */
export const prepareHome = async (
  ops: HomeOps,
  slug: string,
  dryRun: boolean
): Promise<void> => {
  if (dryRun) {
    return;
  }
  await ensureAgentHome(ops, slug);
};

/** In a dry run, listing the agent's home answers an empty folder when the home was never made. */
export const withMissingHomeEmpty = (
  ops: LibraryOps,
  slug: string,
  dryRun: boolean
): LibraryOps => {
  if (!dryRun) {
    return ops;
  }
  const home = agentHomePath(slug);
  return {
    ...ops,
    list: async (dir) => {
      try {
        return await ops.list(dir);
      } catch (error) {
        if (
          dir === home &&
          isServiceError(error) &&
          error.code === "not_found"
        ) {
          return [];
        }
        throw error;
      }
    },
  };
};
