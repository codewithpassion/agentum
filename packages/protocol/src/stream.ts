// What the Worker and the web app agree on for the SSE frames of
// `GET /api/sessions/:sessionId/stream` (V1.1). Browser safe: no drizzle
// imports, only the enum constants from `@repo/db/shared`.
//
// Only `event` frames carry an SSE `id:` (the event ULID), so `Last-Event-ID`
// resumes on stored events only. Delta, run, request and ping frames are not
// replayed.

import {
  EVENT_ACTOR_KINDS,
  EVENT_TYPES,
  REQUEST_KINDS,
  REQUEST_STATUSES,
  RUN_STATUSES,
} from "@repo/db/shared";
import { z } from "zod";

const isoTimestampSchema = z.iso.datetime({ offset: true });
const jsonRecordSchema = z.record(z.string(), z.json());

// The stored event fields every `event` frame carries, with the payload or
// the truncation marker added by the variants below.
const eventFields = {
  actor: z.strictObject({
    id: z.string().min(1),
    kind: z.enum(EVENT_ACTOR_KINDS),
  }),
  createdAt: isoTimestampSchema,
  frame: z.literal("event"),
  id: z.string().min(1),
  runId: z.string().min(1).nullable(),
  seq: z.int().nonnegative().nullable(),
  type: z.enum(EVENT_TYPES),
};

/** An event whose payload is in the frame. */
const inlineEventFrameSchema = z.strictObject({
  ...eventFields,
  payload: jsonRecordSchema,
});

/** An event whose payload went to R2, so the frame says only that it was truncated. */
const truncatedEventFrameSchema = z.strictObject({
  ...eventFields,
  truncated: z.literal(true),
});

export const eventFrameSchema = z.union([
  inlineEventFrameSchema,
  truncatedEventFrameSchema,
]);
export type EventFrame = z.infer<typeof eventFrameSchema>;

/** A partial assistant message. `text` is the full masked text so far. */
export const deltaFrameSchema = z.strictObject({
  frame: z.literal("delta"),
  messageKey: z.string().min(1),
  runId: z.string().min(1),
  text: z.string(),
});
export type DeltaFrame = z.infer<typeof deltaFrameSchema>;

export const runFrameSchema = z.strictObject({
  frame: z.literal("run"),
  runId: z.string().min(1),
  status: z.enum(RUN_STATUSES),
});
export type RunFrame = z.infer<typeof runFrameSchema>;

export const requestFrameSchema = z.strictObject({
  frame: z.literal("request"),
  kind: z.enum(REQUEST_KINDS),
  requestId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(REQUEST_STATUSES),
});
export type RequestFrame = z.infer<typeof requestFrameSchema>;

export const pingFrameSchema = z.strictObject({
  frame: z.literal("ping"),
});
export type PingFrame = z.infer<typeof pingFrameSchema>;

export const streamFrameSchema = z.union([
  eventFrameSchema,
  deltaFrameSchema,
  runFrameSchema,
  requestFrameSchema,
  pingFrameSchema,
]);
export type StreamFrame = z.infer<typeof streamFrameSchema>;
