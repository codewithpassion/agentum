import { and, desc, eq, lt, or } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
  type ActivityDetail,
  type ActivityKind,
  type AgentActivity,
  agentActivity,
} from "./schema";

/**
 * The one way anything an agent does gets recorded. The computer module calls
 * it today; the browser module calls the same function with `browser.*` kinds.
 * Writing an activity row must never be the reason a tool call fails, so
 * `logActivity` swallows its own errors.
 */

export interface LogActivityInput {
  agentId: string;
  detail?: ActivityDetail;
  kind: ActivityKind;
  summary: string;
}

export interface ActivityView {
  createdAt: number;
  detail: ActivityDetail | null;
  id: string;
  kind: ActivityKind;
  summary: string;
}

export const toActivityView = (row: AgentActivity): ActivityView => ({
  createdAt: row.createdAt.getTime(),
  detail: row.detail ?? null,
  id: row.id,
  kind: row.kind,
  summary: row.summary,
});

export const logActivity = async (
  db: Db,
  input: LogActivityInput
): Promise<void> => {
  try {
    await db.insert(agentActivity).values({
      agentId: input.agentId,
      // The column default is `unixepoch() * 1000`, which is whole seconds:
      // several steps of one tool run would share a timestamp and the feed
      // would order them by random id. A JS clock keeps them in sequence.
      createdAt: new Date(),
      detail: input.detail,
      id: crypto.randomUUID(),
      kind: input.kind,
      summary: input.summary,
    });
  } catch {
    // An unrecorded step is a gap in the replay, not a failed tool call.
  }
};

export interface ActivityCursor {
  createdAt: number;
  id: string;
}

const CURSOR_SEPARATOR = ":";

export const encodeActivityCursor = (row: {
  createdAt: Date;
  id: string;
}): string => `${row.createdAt.getTime()}${CURSOR_SEPARATOR}${row.id}`;

export const decodeActivityCursor = (
  raw: string | undefined
): ActivityCursor | undefined => {
  if (!raw) {
    return;
  }
  const separatorIndex = raw.indexOf(CURSOR_SEPARATOR);
  if (separatorIndex <= 0) {
    return;
  }
  const createdAt = Number.parseInt(raw.slice(0, separatorIndex), 10);
  const id = raw.slice(separatorIndex + 1);
  if (!(Number.isFinite(createdAt) && id)) {
    return;
  }
  return { createdAt, id };
};

/** Newest first, the order the right rail reads it in. */
export const listActivity = async (
  db: Db,
  options: { agentId: string; cursor?: ActivityCursor; limit: number }
): Promise<{ entries: ActivityView[]; nextCursor: string | null }> => {
  const { agentId, cursor, limit } = options;
  const cursorCondition = cursor
    ? or(
        lt(agentActivity.createdAt, new Date(cursor.createdAt)),
        and(
          eq(agentActivity.createdAt, new Date(cursor.createdAt)),
          lt(agentActivity.id, cursor.id)
        )
      )
    : undefined;

  const rows = await db
    .select()
    .from(agentActivity)
    .where(and(eq(agentActivity.agentId, agentId), cursorCondition))
    .orderBy(desc(agentActivity.createdAt), desc(agentActivity.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    entries: page.map(toActivityView),
    nextCursor: rows.length > limit && last ? encodeActivityCursor(last) : null,
  };
};
