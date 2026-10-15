import type { Database } from "@repo/db";
import { events } from "@repo/db/schema/events";
import {
  EVENT_ACTOR_KINDS,
  EVENT_TYPES,
  type EventActorKind,
  type EventType,
} from "@repo/db/shared";
import { and, asc, eq, gt, inArray, like, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newEventId } from "./events/ids.ts";
import { capPayload, type Payload, payloadSchema } from "./events/payload.ts";
import { stripSecrets } from "./events/redact.ts";

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

const actorKindSchema = z.enum(EVENT_ACTOR_KINDS);
const typeSchema = z.enum(EVENT_TYPES);

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
    const row: EventRow = {
      actorId: parsed.actor.id,
      actorKind: parsed.actor.kind,
      agentId: parsed.agentId ?? null,
      createdAt: now.toISOString(),
      id,
      payload: JSON.stringify(capped.payload),
      payloadRef: capped.payload_ref?.key ?? null,
      runId: parsed.runId ?? null,
      seq: parsed.seq ?? null,
      sessionId: parsed.sessionId ?? null,
      type: parsed.type,
      workspaceId: parsed.workspaceId,
    };
    await db.insert(events).values(row);
    return toRecord(row);
  };

  /**
   * The messages and tool calls of one session, oldest first. The caller has
   * already checked that the session belongs to the principal's workspace.
   */
  const transcript = async (sessionId: string): Promise<EventRecord[]> => {
    const rows = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.sessionId, sessionId),
          or(like(events.type, "message.%"), like(events.type, "tool.%"))
        )
      )
      .orderBy(asc(events.id));
    return rows.map(toRecord);
  };

  /** Events of one workspace, oldest first, up to `limit`. */
  const query = async (
    workspaceId: string,
    filters: EventFilters = {}
  ): Promise<EventRecord[]> => {
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

  /** The payload of an event, fetched from the blob store when it overflowed. */
  const readPayload = async (event: EventRecord): Promise<Payload> => {
    if (!event.payloadRef) {
      return event.payload;
    }
    const body = await blobs.get(event.payloadRef);
    if (body === null) {
      throw new Error(`Payload blob ${event.payloadRef} is missing`);
    }
    return payloadSchema.parse(JSON.parse(body));
  };

  return { append, query, readPayload, transcript };
};

export type EventsService = ReturnType<typeof createEventsService>;
