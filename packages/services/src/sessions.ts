/**
 * Sessions as the UI and the platform MCP server read them: a list of sessions
 * optionally filtered by agent and origin, one session's transcript with the
 * status of its latest run, and a search over the messages. Writes happen in
 * `runs`.
 */
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { artifacts } from "@repo/db/schema/artifacts";
import { events as eventRows } from "@repo/db/schema/events";
import { inboxThreads } from "@repo/db/schema/inbox";
import { artifactMembers } from "@repo/db/schema/live-artifacts";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { triggers } from "@repo/db/schema/triggers";
import type { AgentRuntime, RunStatus } from "@repo/db/shared";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { payloadSchema } from "./events/payload.ts";
import type { EventRecord, EventsService } from "./events.ts";
import { mailSubjectsOf } from "./mail-subjects.ts";
import { mailTitleOf, runTitleText } from "./mail-title-text.ts";
import { currentGuestRun } from "./runs/guest-scope.ts";
import { loadRun } from "./runs/queries.ts";
import { toRecord, toSummary } from "./runs/records.ts";
import { MAX_RUN_DEPTH } from "./runs/subject.ts";
import {
  type Clock,
  DRY_RUN_ORIGIN,
  type RunSummary,
  type SessionOrigin,
} from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const READ_ACTION = "sessions.read";
const WRITE_ACTION = "sessions.write";
const SESSION_KIND = "session";
/** Dry-run sessions are private to their builder and never listed or searched. */
/** Sessions one list call returns, newest first. */
export const SESSION_LIST_LIMIT = 50;
const TITLE_MAX = 60;
/** The longest name a person may give a thread. */
const TITLE_MAX_STORED = 200;
/** Matching message events one search reads, newest first. */
const SEARCH_EVENT_LIMIT = 200;
const SEARCH_SESSION_LIMIT = 20;
const SEARCH_PASSAGES_PER_SESSION = 3;
const SEARCH_QUERY_MAX = 200;
const PASSAGE_WINDOW = 160;

/** The SQL form of `activityOf`, the order of the list. */
const ACTIVITY = sql<string>`coalesce(${sessions.lastRunAt}, ${sessions.createdAt})`;

/** Matched message events grouped by session, newest first, with a few passages each. */
const groupHits = (
  hits: { event: typeof eventRows.$inferSelect; session: SessionRow }[],
  term: string
): Map<string, { passages: string[]; session: SessionRow }> => {
  const groups = new Map<string, { passages: string[]; session: SessionRow }>();
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
  return groups;
};

/** The principals that read sessions: a user, or a run acting for an agent. */
type Reader = Extract<Principal, { kind: "user" | "run" }>;
export type SessionRow = typeof sessions.$inferSelect;

export interface SessionRecord {
  agentId: string;
  archivedAt: string | null;
  createdAt: string;
  externalKey: string | null;
  id: string;
  lastRunAt: string | null;
  origin: string;
  parentSessionId: string | null;
  pinnedAt: string | null;
  private: boolean;
}

/** A listed session with its title and the state of its latest run. */
export interface SessionListItem extends SessionRecord {
  /** Pass as `cursor` to `list` to get the page after this item. */
  cursor: string;
  latestRunId: string | null;
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
  /**
   * Set when the latest run is queued or offered: the agent's runtime, and whether
   * another run of the same session is running. Null otherwise.
   */
  queue: { otherRunActive: boolean; runtime: AgentRuntime } | null;
  /** The session with its title: named by its origin, else the first message trimmed. */
  session: SessionRecord & { title: string };
}

const toSession = (row: SessionRow): SessionRecord => ({
  agentId: row.agentId,
  archivedAt: row.archivedAt,
  createdAt: row.createdAt,
  externalKey: row.externalKey,
  id: row.id,
  lastRunAt: row.lastRunAt,
  origin: row.origin,
  parentSessionId: row.parentSessionId,
  pinnedAt: row.pinnedAt,
  private: row.private,
});

/** When a session last had activity: its last run, else its creation. */
const activityOf = (row: SessionRow): string => row.lastRunAt ?? row.createdAt;

const CURSOR_SEPARATOR = "~";

/** A list cursor: the activity time and id of the last row of a page. */
const cursorOf = (row: SessionRow): string =>
  `${activityOf(row)}${CURSOR_SEPARATOR}${row.id}`;

const mainKeyOf = (userId: string): string => `main:${userId}`;

const parseCursor = (cursor: string): { at: string; id: string } => {
  const [at, id] = cursor.split(CURSOR_SEPARATOR);
  if (!(at && id)) {
    throw new ServiceError("invalid", "Invalid cursor");
  }
  return { at, id };
};

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

const slackLabelSchema = z.object({ label: z.string() });

/** The `label` of a `slack.named` payload, when it is a non-empty string. */
const labelOf = (payload: string | null): string | null => {
  if (payload === null) {
    return null;
  }
  const parsed = slackLabelSchema.safeParse(JSON.parse(payload));
  return parsed.success && parsed.data.label.trim() !== ""
    ? parsed.data.label
    : null;
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
  reader: Reader,
  at = new Date().toISOString()
): Promise<SQL | undefined> => {
  if (reader.kind === "run") {
    const run = await loadRun(db, reader.runId, reader.workspaceId);
    if (!run || run.agentId !== reader.agentId) {
      return sql`0`;
    }
    if (run.scopeArtifactId) {
      return and(
        eq(sessions.workspaceId, reader.workspaceId),
        eq(sessions.agentId, reader.agentId),
        eq(sessions.origin, "artifact"),
        eq(sessions.externalKey, run.scopeArtifactId),
        sql`exists (select 1 from ${artifacts} where ${artifacts.id} = ${sessions.externalKey} and ${artifacts.workspaceId} = ${sessions.workspaceId} and ${artifacts.deletedAt} is null)`,
        sql`exists (select 1 from ${runs} where ${runs.id} = ${run.id} and ${currentGuestRun(at)})`
      );
    }
  }
  const opener = await openerOf(db, reader);
  return and(
    eq(sessions.workspaceId, reader.workspaceId),
    reader.kind === "run"
      ? sql`(
          not exists (select 1 from ${runs} where ${runs.sessionId} = ${sessions.id}
            and ${runs.subagentLevel} > 0)
          or ${sessions.id} in (
            with recursive owned(id, session_id, hops) as (
              select id, session_id, 0 from runs
                where id = ${reader.runId} and workspace_id = ${reader.workspaceId}
              union all
              select child.id, child.session_id, owned.hops + 1 from runs child indexed by runs_parent_idx
                join owned on child.parent_run_id = owned.id
                where child.workspace_id = ${reader.workspaceId}
                  and child.agent_id = ${reader.agentId} and child.subagent_level > 0
                  and owned.hops < ${MAX_RUN_DEPTH}
            ) select session_id from owned
          )
        )`
      : undefined,
    reader.kind === "run"
      ? or(
          eq(sessions.agentId, reader.agentId),
          and(
            eq(sessions.origin, "artifact"),
            sql`exists (select 1 from ${runs} where ${runs.sessionId} = ${sessions.id} and ${runs.workspaceId} = ${sessions.workspaceId} and ${runs.agentId} = ${reader.agentId})`
          )
        )
      : undefined,
    or(
      and(
        ne(sessions.origin, "artifact"),
        opener === null
          ? and(ne(sessions.origin, "ui"), eq(sessions.private, false))
          : or(
              and(ne(sessions.origin, "ui"), eq(sessions.private, false)),
              eq(sessions.actorId, opener)
            )
      ),
      and(
        eq(sessions.origin, "artifact"),
        sql`exists (select 1 from ${artifacts} where ${artifacts.id} = ${sessions.externalKey} and ${artifacts.workspaceId} = ${sessions.workspaceId} and ${artifacts.deletedAt} is null and (${artifacts.audience} = 'workspace' or ${artifacts.ownerUserId} = ${opener} or ${reader.kind === "user" && reader.isAdmin === true} or exists (select 1 from ${artifactMembers} where ${artifactMembers.artifactId} = ${artifacts.id} and ${artifactMembers.workspaceId} = ${artifacts.workspaceId} and ${artifactMembers.principalKind} = 'user' and ${artifactMembers.userId} = ${opener} and ${artifactMembers.revokedAt} is null and (${artifactMembers.expiresAt} is null or ${artifactMembers.expiresAt} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))))`
      )
    )
  );
};

/** The trigger or thread name a session is titled by, when it has one. */
const sourceName = (
  row: SessionRow,
  triggerNames: Map<string, string>,
  threadTitles: Map<string, string>
): string | undefined => {
  if (row.actorKind === "trigger") {
    return triggerNames.get(row.actorId);
  }
  if (row.origin === "inbox" && row.externalKey !== null) {
    return threadTitles.get(row.externalKey);
  }
};

/** Trigger names by trigger id, one batched read. */
const triggerNamesOf = async (
  db: Database,
  ids: string[]
): Promise<Map<string, string>> => {
  const names = new Map<string, string>();
  if (ids.length === 0) {
    return names;
  }
  const found = await db
    .select({ id: triggers.id, name: triggers.name })
    .from(triggers)
    .where(inArray(triggers.id, ids));
  for (const trigger of found) {
    names.set(trigger.id, trigger.name);
  }
  return names;
};

/** Inbox thread titles by thread id, one batched read. */
const threadTitlesOf = async (
  db: Database,
  ids: string[]
): Promise<Map<string, string>> => {
  const titles = new Map<string, string>();
  if (ids.length === 0) {
    return titles;
  }
  const found = await db
    .select({ id: inboxThreads.id, title: inboxThreads.title })
    .from(inboxThreads)
    .where(inArray(inboxThreads.id, ids));
  for (const thread of found) {
    titles.set(thread.id, thread.title);
  }
  return titles;
};

/** The label of each session's newest `slack.named` event, one batched read. */
const slackLabelsOf = async (
  db: Database,
  sessionIds: string[]
): Promise<Map<string, string | null>> => {
  const labels = new Map<string, string | null>();
  if (sessionIds.length === 0) {
    return labels;
  }
  const found = await db
    .select({ payload: eventRows.payload, sessionId: eventRows.sessionId })
    .from(eventRows)
    .where(
      and(
        eq(eventRows.type, "slack.named"),
        inArray(eventRows.sessionId, sessionIds)
      )
    )
    .orderBy(desc(eventRows.id));
  // Newest first, so the first event seen per session is the newest one.
  for (const event of found) {
    if (event.sessionId !== null && !labels.has(event.sessionId)) {
      labels.set(event.sessionId, labelOf(event.payload));
    }
  }
  return labels;
};

/** What can name a session besides its first message, read once for a set of sessions. */
export interface TitleSources {
  labels: Map<string, string | null>;
  threadTitles: Map<string, string>;
  triggerNames: Map<string, string>;
}

/**
 * Reads the names that title `rows`: a trigger or routine by its trigger, an
 * inbox session by its thread, a Slack session by its label. At most three
 * batched reads cover all the rows, none one per session.
 */
export const loadTitleSources = async (
  db: Database,
  rows: readonly SessionRow[]
): Promise<TitleSources> => {
  const [triggerNames, threadTitles, labels] = await Promise.all([
    triggerNamesOf(
      db,
      rows.flatMap((row) => (row.actorKind === "trigger" ? [row.actorId] : []))
    ),
    threadTitlesOf(
      db,
      rows.flatMap((row) =>
        row.origin === "inbox" && row.externalKey !== null
          ? [row.externalKey]
          : []
      )
    ),
    slackLabelsOf(
      db,
      rows.flatMap((row) => (row.origin === "slack" ? [row.id] : []))
    ),
  ]);
  return { labels, threadTitles, triggerNames };
};

/**
 * The title of a session, or of one run in it when `first` is that run's input.
 * A run started by mail takes its mail's subject first. Then a name from its
 * origin. Otherwise, or when that name is gone, the first message.
 */
export const titleFor = (
  { labels, threadTitles, triggerNames }: TitleSources,
  row: SessionRow,
  first: string,
  mailSubject?: string
): string => {
  const subject = mailTitleOf(mailSubject);
  if (subject !== undefined) {
    return truncate(subject);
  }
  const name = sourceName(row, triggerNames, threadTitles);
  const label = labels.get(row.id) ?? null;
  if (name !== undefined && name.trim() !== "") {
    return truncate(name);
  }
  const text = runTitleText(first);
  return truncate(label === null ? text : `${label}: ${text}`);
};

/**
 * The title of one run among the others of its session: what that run was
 * about, its mail subject or the first line of its input, never the session's
 * own name, so the rows of a thread tell apart.
 */
export const runTitleFor = (first: string, mailSubject?: string): string =>
  truncate(runTitleText(first.split("\n")[0] ?? "", mailSubject));

export const createSessionsService = ({
  db,
  events,
  authorizeScopedRun,
  clock = { now: () => new Date() },
}: {
  db: Database;
  events: EventsService;
  authorizeScopedRun?: (principal: Principal, runId: string) => Promise<void>;
  clock?: Pick<Clock, "now">;
}) => {
  const visibleTo = async (reader: Reader) => {
    if (reader.kind === "run") {
      const run = await loadRun(db, reader.runId, reader.workspaceId);
      if (run?.scopeArtifactId) {
        if (!authorizeScopedRun) {
          throw new ServiceError("not_found", "Session not found");
        }
        await authorizeScopedRun(reader, run.id);
      }
    }
    return visibleSessions(db, reader, clock.now().toISOString());
  };

  /**
   * The title of each session, keyed by session id, see `titleFor`. `firstRuns`
   * holds each session's first run, which the title is named from.
   */
  const titlesFor = async (
    rows: SessionRow[],
    firstRuns: Map<string, { id: string; inputText: string }>,
    workspaceId: string
  ): Promise<Map<string, string>> => {
    const [sources, subjects] = await Promise.all([
      loadTitleSources(db, rows),
      mailSubjectsOf(
        db,
        workspaceId,
        [...firstRuns.values()].map((run) => run.id)
      ),
    ]);
    return new Map(
      rows.map((row) => {
        const first = firstRuns.get(row.id);
        if (row.title !== null && row.title.trim() !== "") {
          return [row.id, row.title];
        }
        return [
          row.id,
          titleFor(
            sources,
            row,
            first?.inputText ?? "",
            first === undefined ? undefined : subjects.get(first.id)
          ),
        ];
      })
    );
  };

  /** Pairs each session row with its latest run's status and title. */
  const withRuns = async (
    rows: SessionRow[],
    workspaceId: string
  ): Promise<SessionListItem[]> => {
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
    const firstRuns = new Map(
      [...bySession].flatMap(([id, sessionRuns]) =>
        sessionRuns[0] ? [[id, sessionRuns[0]] as const] : []
      )
    );
    const titles = await titlesFor(rows, firstRuns, workspaceId);
    return rows.map((row) => ({
      ...toSession(row),
      cursor: cursorOf(row),
      latestRunId: bySession.get(row.id)?.at(-1)?.id ?? null,
      status: bySession.get(row.id)?.at(-1)?.status ?? null,
      title: titles.get(row.id) ?? "",
    }));
  };

  const list = async (
    principal: Principal,
    {
      agentId,
      archived = false,
      cursor,
      limit = SESSION_LIST_LIMIT,
      origin,
    }: {
      agentId?: string;
      /** True lists only archived threads. Otherwise archived ones are left out. */
      archived?: boolean;
      cursor?: string;
      limit?: number;
      origin?: SessionOrigin;
    } = {}
  ): Promise<SessionListItem[]> => {
    const reader = requireReader(principal);
    authorize(reader, READ_ACTION, {
      kind: SESSION_KIND,
      workspaceId: reader.workspaceId,
    });
    const after = cursor === undefined ? undefined : parseCursor(cursor);
    const rows = await db
      .select()
      .from(sessions)
      .where(
        and(
          await visibleTo(reader),
          ne(sessions.origin, DRY_RUN_ORIGIN),
          agentId === undefined ? undefined : eq(sessions.agentId, agentId),
          origin === undefined ? undefined : eq(sessions.origin, origin),
          archived
            ? isNotNull(sessions.archivedAt)
            : isNull(sessions.archivedAt),
          after === undefined
            ? undefined
            : sql`(${ACTIVITY}, ${sessions.id}) < (${after.at}, ${after.id})`
        )
      )
      .orderBy(desc(ACTIVITY), desc(sessions.id))
      .limit(Math.min(limit, SESSION_LIST_LIMIT));
    return withRuns(rows, reader.workspaceId);
  };

  /** The queue state of a session's latest run, see `SessionTranscript.queue`. */
  const queueOf = async (
    session: SessionRow,
    latest: { id: string; status: RunStatus } | undefined
  ): Promise<SessionTranscript["queue"]> => {
    if (
      latest === undefined ||
      (latest.status !== "queued" && latest.status !== "offered")
    ) {
      return null;
    }
    const [agent] = await db
      .select({ runtime: agents.runtime })
      .from(agents)
      .where(
        and(
          eq(agents.id, session.agentId),
          eq(agents.workspaceId, session.workspaceId)
        )
      )
      .limit(1);
    if (agent === undefined) {
      return null;
    }
    const [other] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.sessionId, session.id),
          eq(runs.workspaceId, session.workspaceId),
          inArray(runs.status, ["offered", "running", "waiting"]),
          ne(runs.id, latest.id)
        )
      )
      .limit(1);
    return { otherRunActive: other !== undefined, runtime: agent.runtime };
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
    const titles = await titlesFor(
      [row],
      new Map(sessionRuns[0] ? [[row.id, sessionRuns[0]]] : []),
      reader.workspaceId
    );
    return {
      entries,
      latestRun: latest
        ? { ...toSummary(toRecord(latest)), inputText: latest.inputText }
        : null,
      outputFileIds,
      queue: await queueOf(row, latest),
      session: {
        ...toSession(row),
        title: titles.get(row.id) ?? "",
      },
    };
  };

  /**
   * One session the reader may see, without its transcript. Hidden and unknown
   * sessions both raise `not_found`, so a caller cannot tell them apart.
   */
  const get = async (
    principal: Principal,
    sessionId: string
  ): Promise<SessionRecord> => {
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
    return toSession(row);
  };

  /** Threads of one agent that a person named with `term` in the name, newest first. */
  const namedMatches = async (
    reader: Reader,
    agentId: string,
    term: string
  ): Promise<SessionRow[]> =>
    db
      .select()
      .from(sessions)
      .where(
        and(
          await visibleTo(reader),
          ne(sessions.origin, DRY_RUN_ORIGIN),
          eq(sessions.agentId, agentId),
          sql`${sessions.title} LIKE ${`%${likeEscape(term)}%`} ESCAPE '\\'`
        )
      )
      .orderBy(desc(ACTIVITY), desc(sessions.id))
      .limit(SEARCH_SESSION_LIMIT);

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
          ne(sessions.origin, DRY_RUN_ORIGIN),
          eq(eventRows.workspaceId, reader.workspaceId),
          eq(eventRows.agentId, agentId),
          like(eventRows.type, "message.%"),
          isNull(eventRows.payloadRef),
          sql`${eventRows.payload} LIKE ${pattern} ESCAPE '\\'`
        )
      )
      .orderBy(desc(eventRows.id))
      .limit(SEARCH_EVENT_LIMIT);

    const groups = groupHits(hits, term);
    for (const session of await namedMatches(reader, agentId, term)) {
      if (groups.size < SEARCH_SESSION_LIMIT && !groups.has(session.id)) {
        groups.set(session.id, { passages: [], session });
      }
    }

    const items = await withRuns(
      [...groups.values()].map((group) => group.session),
      reader.workspaceId
    );
    return items.map((session) => ({
      passages: groups.get(session.id)?.passages ?? [],
      session,
    }));
  };

  /** The user behind a write: threads are changed by people, not by runs. */
  const requireWriter = (
    principal: Principal
  ): Extract<Principal, { kind: "user" }> => {
    if (principal.kind !== "user") {
      throw new ForbiddenError(WRITE_ACTION);
    }
    authorize(principal, WRITE_ACTION, {
      kind: SESSION_KIND,
      workspaceId: principal.workspaceId,
    });
    return principal;
  };

  /**
   * The caller's main thread with one agent: a `ui` session keyed
   * `main:<userId>`, created on first use. Two calls racing for the first
   * time end up on one row, the unique index settles it.
   */
  const main = async (
    principal: Principal,
    agentId: string
  ): Promise<SessionListItem> => {
    const writer = requireWriter(principal);
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(eq(agents.id, agentId), eq(agents.workspaceId, writer.workspaceId))
      )
      .limit(1);
    if (!agent) {
      throw new ServiceError("not_found", "Agent not found");
    }
    const now = clock.now().toISOString();
    await db
      .insert(sessions)
      .values({
        actorId: writer.userId,
        actorKind: "user",
        agentId,
        createdAt: now,
        externalKey: mainKeyOf(writer.userId),
        id: ulid(clock.now().getTime()),
        origin: "ui",
        private: false,
        workspaceId: writer.workspaceId,
      })
      .onConflictDoNothing();
    const [row] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, writer.workspaceId),
          eq(sessions.agentId, agentId),
          eq(sessions.origin, "ui"),
          eq(sessions.externalKey, mainKeyOf(writer.userId))
        )
      )
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Session not found");
    }
    const [item] = await withRuns([row], writer.workspaceId);
    if (!item) {
      throw new ServiceError("not_found", "Session not found");
    }
    return item;
  };

  /** Changes one session the writer may see. Hidden and unknown ones both raise `not_found`. */
  const change = async (
    principal: Principal,
    sessionId: string,
    patch: Partial<Pick<SessionRow, "archivedAt" | "pinnedAt" | "title">>
  ): Promise<SessionRecord> => {
    const writer = requireWriter(principal);
    const [row] = await db
      .select()
      .from(sessions)
      .where(and(await visibleTo(writer), eq(sessions.id, sessionId)))
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Session not found");
    }
    await db.update(sessions).set(patch).where(eq(sessions.id, row.id));
    return toSession({ ...row, ...patch });
  };

  const rename = (principal: Principal, sessionId: string, title: string) => {
    const name = title.trim();
    if (name.length < 1 || name.length > TITLE_MAX_STORED) {
      return Promise.reject(
        new ServiceError(
          "invalid",
          `Title must be 1 to ${TITLE_MAX_STORED} characters`
        )
      );
    }
    return change(principal, sessionId, { title: name });
  };

  const pin = (principal: Principal, sessionId: string) =>
    change(principal, sessionId, { pinnedAt: clock.now().toISOString() });

  const unpin = (principal: Principal, sessionId: string) =>
    change(principal, sessionId, { pinnedAt: null });

  const archive = (principal: Principal, sessionId: string) =>
    change(principal, sessionId, { archivedAt: clock.now().toISOString() });

  const unarchive = (principal: Principal, sessionId: string) =>
    change(principal, sessionId, { archivedAt: null });

  return {
    archive,
    get,
    list,
    main,
    pin,
    rename,
    search,
    transcript,
    unarchive,
    unpin,
  };
};

export type SessionsService = ReturnType<typeof createSessionsService>;
