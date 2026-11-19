import type { Database } from "@repo/db";
import { sessions } from "@repo/db/schema/sessions";
import { eq } from "drizzle-orm";
import { peerRootsOf } from "./peer-root.ts";
import type { RunRecord } from "./types.ts";

/**
 * Whether a machine run may end its turn on a question and get the answer as a
 * follow-up run. Only a plain run: work a peer set going, a hand-off child, a
 * subagent, a dry run, an app's run and an artifact-scoped (guest) run keep waiting, since
 * something is waiting on each. The request opens and the run parks under the
 * same rule, so a daemon that asks for more is refused.
 */
export const runDefersQuestions = async (
  db: Database,
  run: RunRecord
): Promise<boolean> => {
  if (
    run.claimedBy === null ||
    run.claimedBy === "system" ||
    run.dryRun ||
    // An app takes one `finished` reply per run, so a run it started cannot answer twice.
    run.reply.kind === "app" ||
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
