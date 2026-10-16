/**
 * Sessions as the UI reads them: a list per agent, and one session's
 * transcript with the status of its latest run. Writes happen in `runs`.
 */
import type { Database } from "@repo/db";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import type { RunStatus } from "@repo/db/shared";
import { and, asc, desc, eq, inArray, ne, or } from "drizzle-orm";
import { authorize, ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import type { EventRecord, EventsService } from "./events.ts";
import { toRecord, toSummary } from "./runs/records.ts";
import type { RunSummary } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const READ_ACTION = "sessions.read";
const SESSION_KIND = "session";
/** Sessions one list call returns, newest first. */
export const SESSION_LIST_LIMIT = 50;
const TITLE_MAX = 80;

type UserPrincipal = Extract<Principal, { kind: "user" }>;
type SessionRow = typeof sessions.$inferSelect;

export interface SessionRecord {
  agentId: string;
  createdAt: string;
  externalKey: string | null;
  id: string;
  lastRunAt: string | null;
  origin: string;
}

/** A listed session with the first message and the state of its latest run. */
export interface SessionListItem extends SessionRecord {
  status: RunStatus | null;
  title: string;
}

/** The latest run of a session, with the text it was started with. */
export type SessionRun = RunSummary & { inputText: string };

export interface SessionTranscript {
  entries: EventRecord[];
  latestRun: SessionRun | null;
  session: SessionRecord;
}

const toSession = (row: SessionRow): SessionRecord => ({
  agentId: row.agentId,
  createdAt: row.createdAt,
  externalKey: row.externalKey,
  id: row.id,
  lastRunAt: row.lastRunAt,
  origin: row.origin,
});

const requireUser = (principal: Principal): UserPrincipal => {
  if (principal.kind !== "user") {
    throw new ForbiddenError(READ_ACTION);
  }
  return principal;
};

const truncate = (text: string): string =>
  text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}...` : text;

export const createSessionsService = ({
  db,
  events,
}: {
  db: Database;
  events: EventsService;
}) => {
  /** UI sessions belong to the user who opened them. Other origins are shared. */
  const visibleTo = (user: UserPrincipal) =>
    and(
      eq(sessions.workspaceId, user.workspaceId),
      or(ne(sessions.origin, "ui"), eq(sessions.actorId, user.userId))
    );

  const list = async (
    principal: Principal,
    { agentId }: { agentId: string }
  ): Promise<SessionListItem[]> => {
    const user = requireUser(principal);
    authorize(user, READ_ACTION, {
      kind: SESSION_KIND,
      workspaceId: user.workspaceId,
    });
    const rows = await db
      .select()
      .from(sessions)
      .where(and(visibleTo(user), eq(sessions.agentId, agentId)))
      .orderBy(desc(sessions.createdAt), desc(sessions.id))
      .limit(SESSION_LIST_LIMIT);
    if (rows.length === 0) {
      return [];
    }
    const runRows = await db
      .select()
      .from(runs)
      .where(
        inArray(
          runs.sessionId,
          rows.map((row) => row.id)
        )
      )
      .orderBy(asc(runs.createdAt), asc(runs.id));
    const bySession = new Map<string, (typeof runRows)[number][]>();
    for (const run of runRows) {
      bySession.set(run.sessionId, [
        ...(bySession.get(run.sessionId) ?? []),
        run,
      ]);
    }
    return rows.map((row) => {
      const sessionRuns = bySession.get(row.id) ?? [];
      return {
        ...toSession(row),
        status: sessionRuns.at(-1)?.status ?? null,
        title: truncate(sessionRuns[0]?.inputText ?? ""),
      };
    });
  };

  const transcript = async (
    principal: Principal,
    sessionId: string
  ): Promise<SessionTranscript> => {
    const user = requireUser(principal);
    const [row] = await db
      .select()
      .from(sessions)
      .where(and(visibleTo(user), eq(sessions.id, sessionId)))
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Session not found");
    }
    authorize(user, READ_ACTION, {
      id: row.id,
      kind: SESSION_KIND,
      workspaceId: row.workspaceId,
    });
    const [latest] = await db
      .select()
      .from(runs)
      .where(eq(runs.sessionId, row.id))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(1);
    const entries = await events.transcript(user, row.workspaceId, row.id);
    return {
      entries,
      latestRun: latest
        ? { ...toSummary(toRecord(latest)), inputText: latest.inputText }
        : null,
      session: toSession(row),
    };
  };

  return { list, transcript };
};

export type SessionsService = ReturnType<typeof createSessionsService>;
