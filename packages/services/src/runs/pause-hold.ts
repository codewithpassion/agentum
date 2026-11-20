import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { runs } from "@repo/db/schema/runs";
import { and, eq, gt, isNotNull, like, notExists, or } from "drizzle-orm";

/** The request id of the follow-up that carries a parked run's answers. */
export const QUESTION_ANSWER_PREFIX = "question-answer:";
/** The request id of the wake a finished child gives its parent. */
export const HANDOFF_WAKE_PREFIX = "handoff-wake:";

/**
 * A claim's condition: a queued run waits while its agent is paused, and goes
 * on once the agent is resumed. A subagent and the follow-ups of work under way
 * are not held, because the cap never kills a task.
 */
export const notHeldByPause = (db: Database) =>
  or(
    gt(runs.subagentLevel, 0),
    like(runs.requestId, `${QUESTION_ANSWER_PREFIX}%`),
    like(runs.requestId, `${HANDOFF_WAKE_PREFIX}%`),
    notExists(
      db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, runs.agentId), isNotNull(agents.pausedAt)))
    )
  );
