import type { Database } from "@repo/db";
import { sessions } from "@repo/db/schema/sessions";
import { eq } from "drizzle-orm";
import { peerRootsOf } from "./peer-root.ts";
import type { RunRecord } from "./types.ts";

/**
 * Whether the answer to something a run asked can come back as a follow-up run
 * in its session. Only a plain run: work a peer set going, a hand-off child, a
 * subagent, a dry run, an app's or a peer task's run and an artifact-scoped
 * (guest) run cannot, since something is waiting on each.
 */
export const runTakesFollowUp = async (
  db: Database,
  run: RunRecord
): Promise<boolean> => {
  if (
    run.dryRun ||
    // An app and a peer's task each take one reply per run, and it ends them, so these runs cannot reply twice.
    run.reply.kind === "app" ||
    run.reply.kind === "a2a" ||
    run.scopeArtifactId !== null ||
    run.parentRunId !== null ||
    run.subagentLevel > 0 ||
    (await peerRootsOf(db, run)).length > 0
  ) {
    return false;
  }
  const [session] = await db
    .select({ origin: sessions.origin })
    .from(sessions)
    .where(eq(sessions.id, run.sessionId))
    .limit(1);
  return session !== undefined && session.origin !== "artifact";
};

/**
 * Whether a machine run may end its turn on a question and get the answer as a
 * follow-up run. A plain run on a machine (see `runTakesFollowUp`). The request
 * opens and the run parks under the same rule, so a daemon that asks for more
 * is refused.
 */
export const runDefersQuestions = async (
  db: Database,
  run: RunRecord
): Promise<boolean> =>
  run.claimedBy !== null &&
  run.claimedBy !== "system" &&
  (await runTakesFollowUp(db, run));
