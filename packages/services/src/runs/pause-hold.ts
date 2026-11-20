import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { runs } from "@repo/db/schema/runs";
import {
  type AnyColumn,
  and,
  eq,
  gt,
  isNotNull,
  like,
  notExists,
  or,
} from "drizzle-orm";

/** The request id of the follow-up that carries a parked run's answers. */
export const QUESTION_ANSWER_PREFIX = "question-answer:";
/** The request id of the wake a finished child gives its parent. */
export const HANDOFF_WAKE_PREFIX = "handoff-wake:";

const RESERVED_PREFIXES = [QUESTION_ANSWER_PREFIX, HANDOFF_WAKE_PREFIX];

/**
 * Whether a caller-chosen request id would pass for one of those follow-ups.
 * `startRun` refuses it unless the start is one, so the exemption below
 * cannot be forged.
 */
export const isReservedRequestId = (requestId: string): boolean =>
  RESERVED_PREFIXES.some((prefix) => requestId.startsWith(prefix));

/**
 * A claim's condition on `run` (the table, or an alias of it): a queued run
 * waits while its agent is paused, and goes on once the agent is resumed. A
 * subagent and the follow-ups of work under way are not held, because the cap
 * never kills a task. Put on the "older run still waiting" check too, so a held
 * run does not block the follow-up behind it.
 */
export const notHeldByPause = (
  db: Database,
  run: {
    agentId: AnyColumn;
    requestId: AnyColumn;
    subagentLevel: AnyColumn;
  } = runs
) =>
  or(
    gt(run.subagentLevel, 0),
    ...RESERVED_PREFIXES.map((prefix) => like(run.requestId, `${prefix}%`)),
    notExists(
      db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, run.agentId), isNotNull(agents.pausedAt)))
    )
  );
