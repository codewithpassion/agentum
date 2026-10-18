// The library folder an agent keeps its own files in, `agents/<slug>`. A
// convention only: any member may still write there.
import { isServiceError } from "../errors.ts";

/** The library calls the home needs, with the caller's principal already bound. */
export interface HomeOps {
  mkdir: (path: string) => Promise<unknown>;
  stat: (path: string) => Promise<unknown>;
}

/** The library path of an agent's home, without a leading or trailing slash. */
export const agentHomePath = (slug: string): string => `agents/${slug}`;

/** Makes the agent's home folder when it is missing, and does nothing when it is there. */
export const ensureAgentHome = async (
  ops: HomeOps,
  slug: string
): Promise<void> => {
  const path = agentHomePath(slug);
  try {
    await ops.stat(path);
  } catch (error) {
    if (!(isServiceError(error) && error.code === "not_found")) {
      throw error;
    }
    await ops.mkdir(path);
  }
};
