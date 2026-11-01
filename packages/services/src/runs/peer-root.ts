import type { Database } from "@repo/db";
import { loadRun } from "./queries.ts";
import { MAX_RUN_DEPTH } from "./subject.ts";
import type { RunRecord } from "./types.ts";

/**
 * Every connection whose peer set `run` or a run it descends from going, nearest
 * first: a run a peer started, a hand-off through `send_message`, or a wake with
 * a peer's answer. A peer's text is outside input, so the gate on a run's tools
 * follows the whole chain, and each link in it counts.
 */
export const peerRootsOf = async (
  db: Database,
  run: Pick<RunRecord, "actor" | "parentRunId" | "workspaceId">
): Promise<string[]> => {
  const roots: string[] = [];
  let current = run;
  for (let depth = 0; depth <= MAX_RUN_DEPTH + 1; depth += 1) {
    if (current.actor.kind === "peer") {
      roots.push(current.actor.id);
    }
    if (!current.parentRunId) {
      return roots;
    }
    // biome-ignore lint/performance/noAwaitInLoops: the chain is at most MAX_RUN_DEPTH long and each step needs the last
    const parent = await loadRun(db, current.parentRunId, current.workspaceId);
    if (!parent) {
      return roots;
    }
    current = parent;
  }
  return roots;
};

/** The nearest connection in the chain `peerRootsOf` walks, or null when no peer set the run going. */
export const peerRootOf = async (
  db: Database,
  run: Pick<RunRecord, "actor" | "parentRunId" | "workspaceId">
): Promise<string | null> => (await peerRootsOf(db, run))[0] ?? null;
