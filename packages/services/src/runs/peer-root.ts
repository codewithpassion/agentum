import type { Database } from "@repo/db";
import { loadRun } from "./queries.ts";
import { MAX_RUN_DEPTH } from "./subject.ts";
import type { RunRecord } from "./types.ts";

/**
 * The connection whose peer started `run`, or started a run it descends from
 * (a hand-off through `send_message`), or null. A peer's text is outside input,
 * so the gate on its tools follows the whole chain of runs it set going.
 */
export const peerRootOf = async (
  db: Database,
  run: Pick<RunRecord, "actor" | "parentRunId" | "workspaceId">
): Promise<string | null> => {
  let current = run;
  for (let depth = 0; depth <= MAX_RUN_DEPTH + 1; depth += 1) {
    if (current.actor.kind === "peer") {
      return current.actor.id;
    }
    if (!current.parentRunId) {
      return null;
    }
    // biome-ignore lint/performance/noAwaitInLoops: the chain is at most MAX_RUN_DEPTH long and each step needs the last
    const parent = await loadRun(db, current.parentRunId, current.workspaceId);
    if (!parent) {
      return null;
    }
    current = parent;
  }
  return null;
};
