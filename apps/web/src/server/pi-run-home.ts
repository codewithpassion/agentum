// The agent's library home in an isolate run. A dry run writes nothing to the
// library, so it does not make the home.
import { ensureAgentHome, type HomeOps } from "@repo/services/library/home";

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
