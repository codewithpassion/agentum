import type { Database } from "@repo/db";
import type { Statement } from "@repo/db/atomic";
import { events } from "@repo/db/schema/events";
import { sessions } from "@repo/db/schema/sessions";
import {
  EVENT_ACTOR_KINDS,
  EVENT_TYPES,
  type EventActorKind,
  type EventType,
} from "@repo/db/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  like,
  lt,
  or,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { newEventId } from "./events/ids.ts";
import {
  capPayload,
  PAYLOAD_MAX_BYTES,
  type Payload,
  payloadSchema,
} from "./events/payload.ts";
import { stripSecrets } from "./events/redact.ts";
import { summarize } from "./events/summary.ts";
import { visibleSessions } from "./sessions.ts";
import type { Principal } from "./workspaces.ts";

const EVENT_READ = "events.read";
const EVENT_KIND = "event";

const idString = z.string().min(1).max(200);

/**
 * What a caller hands to `append`. The service mints the id and the timestamp.
 * A payload over 64 KB is accepted here and moved to the blob store by the
 * service, so the size cap is not part of this schema.
 */
export const eventInputSchema = z.strictObject({
  actor: z.strictObject({
    id: idString,
    kind: z.enum(EVENT_ACTOR_KINDS),
  }),
  agentId: idString.nullish(),
  payload: payloadSchema.default({}),
  runId: idString.nullish(),
  seq: z.number().int().min(0).nullish(),
  sessionId: idString.nullish(),
  type: z.enum(EVENT_TYPES),
  workspaceId: idString,
});
export type EventInput = z.input<typeof eventInputSchema>;

export const EVENT_QUERY_MAX_LIMIT = 500;

export const eventFiltersSchema = z.strictObject({
  // Exclusive cursor: only events with a larger id.
  after: idString.optional(),
  agentId: idString.optional(),
  limit: z.number().int().min(1).max(EVENT_QUERY_MAX_LIMIT).default(100),
  runId: idString.optional(),
  sessionId: idString.optional(),
  types: z.array(z.enum(EVENT_TYPES)).min(1).optional(),
});
export type EventFilters = z.input<typeof eventFiltersSchema>;

export const EVENT_LOG_MAX_LIMIT = 100;

/** Filters of the workspace event log. `from` is inclusive and `to` exclusive, both ISO timestamps. */
export const eventLogFiltersSchema = z.strictObject({
  agentId: idString.optional(),
  from: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(EVENT_LOG_MAX_LIMIT).default(25),
  // Zero-based page number, newest events first.
  page: z.number().int().min(0).default(0),
  to: z.iso.datetime().optional(),
  types: z.array(z.enum(EVENT_TYPES)).min(1).optional(),
});
export type EventLogFilters = z.input<typeof eventLogFiltersSchema>;

/** One row of the event log. The payload stays out, only a short summary of it goes along. */
export interface EventLogEntry {
  actor: { id: string; kind: EventActorKind };
  agentId: string | null;
  createdAt: string;
  id: string;
  runId: string | null;
  sessionId: string | null;
  summary: string;
  type: EventType;
}

export interface EventLogPage {
  entries: EventLogEntry[];
  hasMore: boolean;
}

/** Where oversized payloads go: R2 in the app, a Map in tests. */
export interface Blobs {
  get: (key: string) => Promise<string | null>;
  put: (key: string, body: string) => Promise<void>;
}

export interface EventRecord {
  actor: { id: string; kind: EventActorKind };
  agentId: string | null;
  createdAt: string;
  id: string;
  /** Empty when `payloadRef` is set. Read the full body with `readPayload`. */
  payload: Payload;
  /** Blob key of a payload that was over 64 KB. */
  payloadRef: string | null;
  runId: string | null;
  seq: number | null;
  sessionId: string | null;
  type: EventType;
  workspaceId: string;
}

type EventRow = typeof events.$inferSelect;
type ParsedEventInput = z.output<typeof eventInputSchema>;

const actorKindSchema = z.enum(EVENT_ACTOR_KINDS);
const typeSchema = z.enum(EVENT_TYPES);

/** The row for a parsed input, with the id and time the caller minted. */
const toRow = (
  parsed: ParsedEventInput,
  id: string,
  now: Date,
  payload: Record<string, unknown>,
  payloadRef: string | null
): EventRow => ({
  actorId: parsed.actor.id,
  actorKind: parsed.actor.kind,
  agentId: parsed.agentId ?? null,
  createdAt: now.toISOString(),
  id,
  payload: JSON.stringify(payload),
  payloadRef,
  runId: parsed.runId ?? null,
  seq: parsed.seq ?? null,
  sessionId: parsed.sessionId ?? null,
  type: parsed.type,
  workspaceId: parsed.workspaceId,
});

const toRecord = (row: EventRow): EventRecord => ({
  actor: { id: row.actorId, kind: actorKindSchema.parse(row.actorKind) },
  agentId: row.agentId,
  createdAt: row.createdAt,
  id: row.id,
  payload: payloadSchema.parse(JSON.parse(row.payload ?? "{}")),
  payloadRef: row.payloadRef,
  runId: row.runId,
  seq: row.seq,
  sessionId: row.sessionId,
  type: typeSchema.parse(row.type),
  workspaceId: row.workspaceId,
});

/**
 * The append-only event log (contract C5). Secrets are stripped from every
 * payload before it is stored, and a payload over 64 KB goes to `blobs` with
 * its key in `payload_ref`.
 */
export const createEventsService = ({
  blobs,
  db,
}: {
  blobs: Blobs;
  db: Database;
}) => {
  const listeners: Array<(event: EventRecord) => Promise<void>> = [];

  /**
   * Runs after each `append`, for side effects that follow an event, such as
   * the Slack gateway telling a person to connect an account. A listener runs
   * inside the request that appended, so it must be quick and must not throw.
   * A listener that fails is logged and does not fail the append.
   */
  const onAppend = (listener: (event: EventRecord) => Promise<void>): void => {
    listeners.push(listener);
  };

  const append = async (input: EventInput): Promise<EventRecord> => {
    const parsed = eventInputSchema.parse(input);
    const now = new Date();
    const id = newEventId(now);
    const redacted = payloadSchema.parse(stripSecrets(parsed.payload));
    // The blob goes in first, so a row never points at a missing blob.
    const capped = await capPayload(redacted, {
      key: `payloads/${parsed.workspaceId}/${id}.json`,
      store: blobs.put,
    });
    const row = toRow(
      parsed,
      id,
      now,
      capped.payload,
      capped.payload_ref?.key ?? null
    );
    await db.insert(events).values(row);
    const record = toRecord(row);
    for (const listener of listeners) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: listeners run one at a time, in registration order
        await listener(record);
      } catch (error) {
        console.error("Event listener failed", error);
      }
    }
    return record;
  };

  /**
   * An unexecuted insert for `atomic`, for a write that must land with others.
   * Like `append` it strips secrets, but it has no blob store, so a payload
   * over 64 KB is refused instead of moved. It does not notify `onAppend`
   * listeners, because the row is not written yet when this returns.
   */
  const insertStatement = (input: EventInput): Statement => {
    const parsed = eventInputSchema.parse(input);
    const now = new Date();
    const id = newEventId(now);
    const redacted = payloadSchema.parse(stripSecrets(parsed.payload));
    const size = new TextEncoder().encode(JSON.stringify(redacted)).byteLength;
    if (size > PAYLOAD_MAX_BYTES) {
      throw new ServiceError(
        "invalid",
        "Payload too large for an atomic write"
      );
    }
    return db.insert(events).values(toRow(parsed, id, now, redacted, null));
  };

  /**
   * The messages and tool calls of one session, oldest first. Authorizes the
   * principal against `workspaceId` and filters on it, so a session id from
   * another workspace returns nothing.
   */
  const transcript = async (
    principal: Principal,
    workspaceId: string,
    sessionId: string
  ): Promise<EventRecord[]> => {
    authorize(principal, EVENT_READ, { kind: EVENT_KIND, workspaceId });
    const rows = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.workspaceId, workspaceId),
          eq(events.sessionId, sessionId),
          or(like(events.type, "message.%"), like(events.type, "tool.%"))
        )
      )
      .orderBy(asc(events.id));
    return rows.map(toRecord);
  };

  /** Events of one workspace, oldest first, up to `limit`. */
  const query = async (
    principal: Principal,
    workspaceId: string,
    filters: EventFilters = {}
  ): Promise<EventRecord[]> => {
    authorize(principal, EVENT_READ, { kind: EVENT_KIND, workspaceId });
    const f = eventFiltersSchema.parse(filters);
    const conditions: SQL[] = [eq(events.workspaceId, workspaceId)];
    if (f.after) {
      conditions.push(gt(events.id, f.after));
    }
    if (f.agentId) {
      conditions.push(eq(events.agentId, f.agentId));
    }
    if (f.runId) {
      conditions.push(eq(events.runId, f.runId));
    }
    if (f.sessionId) {
      conditions.push(eq(events.sessionId, f.sessionId));
    }
    if (f.types) {
      conditions.push(inArray(events.type, f.types));
    }
    const rows = await db
      .select()
      .from(events)
      .where(and(...conditions))
      .orderBy(asc(events.id))
      .limit(f.limit);
    return rows.map(toRecord);
  };

  /**
   * One page of the workspace's events, newest first, for the log page. Events
   * of a session follow the sessions rules: a UI session or private session
   * (a Slack DM) shows only to the user who opened it. Events outside any
   * session show to the whole workspace.
   */
  const list = async (
    principal: Principal,
    filters: EventLogFilters = {}
  ): Promise<EventLogPage> => {
    if (principal.kind !== "user" && principal.kind !== "run") {
      throw new ForbiddenError(EVENT_READ);
    }
    authorize(principal, EVENT_READ, {
      kind: EVENT_KIND,
      workspaceId: principal.workspaceId,
    });
    const f = eventLogFiltersSchema.parse(filters);
    const visible = await visibleSessions(db, principal);
    const conditions: SQL[] = [
      eq(events.workspaceId, principal.workspaceId),
      or(
        isNull(events.sessionId),
        inArray(
          events.sessionId,
          db.select({ id: sessions.id }).from(sessions).where(visible)
        )
      ) as SQL,
    ];
    if (f.agentId) {
      conditions.push(eq(events.agentId, f.agentId));
    }
    if (f.from) {
      conditions.push(gte(events.createdAt, f.from));
    }
    if (f.to) {
      conditions.push(lt(events.createdAt, f.to));
    }
    if (f.types) {
      conditions.push(inArray(events.type, f.types));
    }
    const rows = await db
      .select()
      .from(events)
      .where(and(...conditions))
      .orderBy(desc(events.id))
      .limit(f.limit + 1)
      .offset(f.page * f.limit);
    return {
      entries: rows.slice(0, f.limit).map((row) => {
        const record = toRecord(row);
        return {
          actor: record.actor,
          agentId: record.agentId,
          createdAt: record.createdAt,
          id: record.id,
          runId: record.runId,
          sessionId: record.sessionId,
          summary: summarize(record.payload),
          type: record.type,
        };
      }),
      hasMore: rows.length > f.limit,
    };
  };

  /** The payload of an event, fetched from the blob store when it overflowed. */
  const readPayload = async (
    principal: Principal,
    event: EventRecord
  ): Promise<Payload> => {
    authorize(principal, EVENT_READ, {
      id: event.id,
      kind: EVENT_KIND,
      workspaceId: event.workspaceId,
    });
    if (!event.payloadRef) {
      return event.payload;
    }
    const body = await blobs.get(event.payloadRef);
    if (body === null) {
      throw new Error(`Payload blob ${event.payloadRef} is missing`);
    }
    return payloadSchema.parse(JSON.parse(body));
  };

  return {
    append,
    insertStatement,
    list,
    onAppend,
    query,
    readPayload,
    transcript,
  };
};

export type EventsService = ReturnType<typeof createEventsService>;
