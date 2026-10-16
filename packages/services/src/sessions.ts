/**
 * Sessions as the UI and the platform MCP server read them: a list of sessions
 * optionally filtered by agent and origin, one session's transcript with the
 * status of its latest run, and a search over the messages. Writes happen in
 * `runs`.
 */
import type { Database } from "@repo/db";
import { events as eventRows } from "@repo/db/schema/events";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import type { RunStatus } from "@repo/db/shared";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  like,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { authorize, ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { payloadSchema } from "./events/payload.ts";
import type { EventRecord, EventsService } from "./events.ts";
import { loadRun } from "./runs/queries.ts";
import { toRecord, toSummary } from "./runs/records.ts";
import type { RunSummary, SessionOrigin } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const READ_ACTION = "sessions.read";
const SESSION_KIND = "session";
/** Sessions one list call returns, newest first. */
export const SESSION_LIST_LIMIT = 50;
const TITLE_MAX = 60;
/** Matching message events one search reads, newest first. */
const SEARCH_EVENT_LIMIT = 200;
const SEARCH_SESSION_LIMIT = 20;
const SEARCH_PASSAGES_PER_SESSION = 3;
const SEARCH_QUERY_MAX = 200;
const PASSAGE_WINDOW = 160;

/** The principals that read sessions: a user, or a run acting for an agent. */
type Reader = Extract<Principal, { kind: "user" | "run" }>;
type SessionRow = typeof sessions.$inferSelect;

export interface SessionRecord {
  agentId: string;
  createdAt: string;
  externalKey: string | null;
  id: string;
  lastRunAt: string | null;
  origin: string;
  private: boolean;
}

/** A listed session with the first message and the state of its latest run. */
export interface SessionListItem extends SessionRecord {
  status: RunStatus | null;
  title: string;
}

/** A session that matched a search, with up to three passages from its messages. */
export interface SessionSearchHit {
  passages: string[];
  session: SessionListItem;
}

/** The latest run of a session, with the text it was started with. */
export type SessionRun = RunSummary & { inputText: string };

export interface SessionTranscript {
  entries: EventRecord[];
  latestRun: SessionRun | null;
  /** Output file ids of every run in the session, keyed by run id. Runs with no outputs are absent. */
  outputFileIds: Record<string, string[]>;
  /** The session with its title, the first message trimmed. Empty when it has no run. */
  session: SessionRecord & { title: string };
}

const toSession = (row: SessionRow): SessionRecord => ({
  agentId: row.agentId,
  createdAt: row.createdAt,
  externalKey: row.externalKey,
  id: row.id,
  lastRunAt: row.lastRunAt,
  origin: row.origin,
  private: row.private,
});

const requireReader = (principal: Principal): Reader => {
  if (principal.kind !== "user" && principal.kind !== "run") {
    throw new ForbiddenError(READ_ACTION);
  }
  return principal;
};

const truncate = (raw: string): string => {
  const text = raw.trim();
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}...` : text;
};

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text as it appears inside a JSON string literal, so it matches raw payload JSON. */
const jsonEscape = (text: string): string => JSON.stringify(text).slice(1, -1);

/** Escapes the LIKE wildcards and the escape character itself. */
const likeEscape = (text: string): string => text.replace(/[\\%_]/g, "\\$&");

/** `PASSAGE_WINDOW` characters around the first case-insensitive match, with "..." at a cut end. */
const cutAround = (source: string, term: string): string => {
  const at = Math.max(0, source.search(new RegExp(escapeRegExp(term), "i")));
  const span = Math.max(PASSAGE_WINDOW, term.length);
  const start = Math.max(0, at - Math.floor((span - term.length) / 2));
  const end = Math.min(source.length, start + span);
  return `${start > 0 ? "..." : ""}${source.slice(start, end)}${end < source.length ? "..." : ""}`;
};

/** The passage of a matched event: its `text`, else its raw payload JSON. */
const passageOf = (rawPayload: string, term: string): string => {
  const { text } = payloadSchema.parse(JSON.parse(rawPayload));
  return typeof text === "string"
    ? cutAround(text, term)
    : cutAround(rawPayload, jsonEscape(term));
};

/**
 * The user a reader acts for, whose UI sessions it may see. Null when a run is
 * missing or has no user behind it.
 */
const openerOf = async (
  db: Database,
  reader: Reader
): Promise<string | null> => {
  if (reader.kind === "user") {
    return reader.userId;
  }
  const run = await loadRun(db, reader.runId, reader.workspaceId);
  return run?.onBehalfOfUserId ?? null;
};

/**
 * Sessions the reader may see. UI sessions and private ones (a Slack DM)
 * belong to the user who opened them, so only that user sees them; other
 * sessions are shared. A run sees only its own agent's sessions.
 */
export const visibleSessions = async (
  db: Database,
  reader: Reader
): Promise<SQL | undefined> => {
  const opener = await openerOf(db, reader);
  return and(
    eq(sessions.workspaceId, reader.workspaceId),
    reader.kind === "run" ? eq(sessions.agentId, reader.agentId) : undefined,
    opener === null
      ? and(ne(sessions.origin, "ui"), eq(sessions.private, false))
      : or(
          and(ne(sessions.origin, "ui"), eq(sessions.private, false)),
          eq(sessions.actorId, opener)
        )
  );
};

export const createSessionsService = ({
  db,
  events,
}: {
  db: Database;
  events: EventsService;
}) => {
  const visibleTo = (reader: Reader) => visibleSessions(db, reader);

  /** Pairs each session row with its latest run's status and first message. */
  const withRuns = async (rows: SessionRow[]): Promise<SessionListItem[]> => {
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

  const list = async (
    principal: Principal,
    { agentId, origin }: { agentId?: string; origin?: SessionOrigin } = {}
  ): Promise<SessionListItem[]> => {
    const reader = requireReader(principal);
    authorize(reader, READ_ACTION, {
      kind: SESSION_KIND,
      workspaceId: reader.workspaceId,
    });
    const rows = await db
      .select()
      .from(sessions)
      .where(
        and(
          await visibleTo(reader),
          agentId === undefined ? undefined : eq(sessions.agentId, agentId),
          origin === undefined ? undefined : eq(sessions.origin, origin)
        )
      )
      .orderBy(desc(sessions.createdAt), desc(sessions.id))
      .limit(SESSION_LIST_LIMIT);
    return withRuns(rows);
  };

  const transcript = async (
    principal: Principal,
    sessionId: string
  ): Promise<SessionTranscript> => {
    const reader = requireReader(principal);
    const [row] = await db
      .select()
      .from(sessions)
      .where(and(await visibleTo(reader), eq(sessions.id, sessionId)))
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Session not found");
    }
    authorize(reader, READ_ACTION, {
      id: row.id,
      kind: SESSION_KIND,
      workspaceId: row.workspaceId,
    });
    const sessionRuns = await db
      .select()
      .from(runs)
      .where(eq(runs.sessionId, row.id))
      .orderBy(asc(runs.createdAt), asc(runs.id));
    const latest = sessionRuns.at(-1);
    const outputFileIds: Record<string, string[]> = {};
    for (const run of sessionRuns) {
      const { outputFileIds: fileIds } = toRecord(run);
      if (fileIds.length > 0) {
        outputFileIds[run.id] = fileIds;
      }
    }
    const entries = await events.transcript(reader, row.workspaceId, row.id);
    return {
      entries,
      latestRun: latest
        ? { ...toSummary(toRecord(latest)), inputText: latest.inputText }
        : null,
      outputFileIds,
      session: {
        ...toSession(row),
        title: truncate(sessionRuns[0]?.inputText ?? ""),
      },
    };
  };

  /**
   * Sessions of one agent whose messages contain `query`, newest match first.
   * The query is matched against the payload JSON, so it is JSON-escaped first.
   * Payloads in blob storage are not searched.
   */
  const search = async (
    principal: Principal,
    { agentId, query }: { agentId: string; query: string }
  ): Promise<SessionSearchHit[]> => {
    const reader = requireReader(principal);
    authorize(reader, READ_ACTION, {
      kind: SESSION_KIND,
      workspaceId: reader.workspaceId,
    });
    const term = query.trim();
    if (term.length < 1 || term.length > SEARCH_QUERY_MAX) {
      throw new ServiceError(
        "invalid",
        `Query must be 1 to ${SEARCH_QUERY_MAX} characters`
      );
    }
    if (reader.kind === "run" && agentId !== reader.agentId) {
      return [];
    }
    const pattern = `%${likeEscape(jsonEscape(term))}%`;
    const hits = await db
      .select({ event: eventRows, session: sessions })
      .from(eventRows)
      .innerJoin(sessions, eq(eventRows.sessionId, sessions.id))
      .where(
        and(
          await visibleTo(reader),
          eq(eventRows.workspaceId, reader.workspaceId),
          eq(eventRows.agentId, agentId),
          like(eventRows.type, "message.%"),
          isNull(eventRows.payloadRef),
          sql`${eventRows.payload} LIKE ${pattern} ESCAPE '\\'`
        )
      )
      .orderBy(desc(eventRows.id))
      .limit(SEARCH_EVENT_LIMIT);

    const groups = new Map<
      string,
      { passages: string[]; session: SessionRow }
    >();
    for (const { event, session } of hits) {
      let group = groups.get(session.id);
      if (!group) {
        if (groups.size === SEARCH_SESSION_LIMIT) {
          continue;
        }
        group = { passages: [], session };
        groups.set(session.id, group);
      }
      if (group.passages.length < SEARCH_PASSAGES_PER_SESSION) {
        group.passages.push(passageOf(event.payload ?? "{}", term));
      }
    }

    const items = await withRuns(
      [...groups.values()].map((group) => group.session)
    );
    return items.map((session) => ({
      passages: groups.get(session.id)?.passages ?? [],
      session,
    }));
  };

  return { list, search, transcript };
};

export type SessionsService = ReturnType<typeof createSessionsService>;
