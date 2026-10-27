/** Browser-safe live contracts. Services derive identity; clients only supply cursor fields. */
import {
  ARTIFACT_MEMBER_ROLES,
  LIVE_KINDS,
  ROOM_CONNECTION_MINUTES,
  ROOM_TICKET_SECONDS,
} from "@repo/db/shared";
import { z } from "zod";

const id = z.string().min(1).max(200);
const kind = z.enum(["member", "guest", "agent"]);
export const liveRoleSchema = z.enum([...ARTIFACT_MEMBER_ROLES, "owner"]);
const positionId = z.strictObject({
  client: z.int().nonnegative(),
  clock: z.int().nonnegative(),
});
export const relativePositionSchema = z
  .strictObject({
    assoc: z.int().optional(),
    item: positionId.optional(),
    tname: z.string().max(200).optional(),
    type: positionId.optional(),
  })
  .refine(
    (p) => p.type !== undefined || p.tname !== undefined,
    "Shared type required"
  );
export type RelativePositionJSON = z.infer<typeof relativePositionSchema>;
export const commentAnchorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    detached: z.boolean().default(false),
    end: relativePositionSchema,
    kind: z.literal("document"),
    start: relativePositionSchema,
  }),
  z.strictObject({
    detached: z.boolean().default(false),
    elementId: id.optional(),
    kind: z.literal("deck"),
    slideId: id,
  }),
]);
export type CommentAnchor = z.infer<typeof commentAnchorSchema>;
export const awarenessEntrySchema = z
  .strictObject({
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    cursor: z
      .strictObject({
        anchor: relativePositionSchema,
        head: relativePositionSchema,
      })
      .optional(),
    id,
    kind,
    name: z.string().min(1).max(200),
    pointer: z
      .strictObject({ x: z.number().finite(), y: z.number().finite() })
      .optional(),
    selection: z.array(id).max(200).optional(),
    slideId: id.optional(),
    status: z.string().max(200).optional(),
  })
  .refine(
    (p) => p.kind === "agent" || p.status === undefined,
    "Agent status only"
  );
export type AwarenessEntry = z.infer<typeof awarenessEntrySchema>;
/** Unix seconds. Verify signature, audience and room binding before atomically consuming jti. */
export const roomTicketClaimsSchema = z
  .strictObject({
    artifactId: z.uuid(),
    audience: z.literal("artifact-room"),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    connectionExpiresAt: z.int().positive(),
    expiresAt: z.int().positive(),
    issuedAt: z.int().nonnegative(),
    jti: id,
    kind,
    name: z.string().min(1).max(200),
    participantId: id,
    role: liveRoleSchema,
    version: z.literal(1),
    workspaceId: id,
  })
  .refine(
    (c) =>
      c.expiresAt > c.issuedAt &&
      c.expiresAt - c.issuedAt <= ROOM_TICKET_SECONDS &&
      c.connectionExpiresAt >= c.expiresAt &&
      c.connectionExpiresAt - c.issuedAt <= ROOM_CONNECTION_MINUTES * 60,
    "Invalid ticket lifetime"
  )
  .refine((c) => c.kind !== "guest" || c.role !== "owner", "Guest cannot own");
export type RoomTicketClaims = z.infer<typeof roomTicketClaimsSchema>;
export const speakerLocationSchema = z.strictObject({
  blockId: id.optional(),
  elementId: id.optional(),
  elementIds: z.array(id).max(200).optional(),
  selection: z.string().max(8192).optional(),
  slideId: id.optional(),
  slideNumber: z.int().positive().optional(),
  threadId: id.optional(),
});
const speaker = z.strictObject({
  id,
  kind,
  name: z.string().min(1).max(200),
  role: z.string().min(1).max(100),
});
export const speakerEnvelopeSchema = z.strictObject({
  harbourmaster_turn: z.strictObject({
    artifact: z
      .strictObject({
        id: z.uuid(),
        kind: z.enum(LIVE_KINDS),
        title: z.string().max(500),
      })
      .optional(),
    from: speaker,
    present: z
      .array(
        speaker.extend({
          kind: kind.optional(),
          where: speakerLocationSchema.optional(),
        })
      )
      .max(1000)
      .optional(),
    text: z.string(),
    via: z.enum([
      "artifact_thread",
      "ask_agent",
      "comment",
      "web_chat",
      "slack",
    ]),
    where: speakerLocationSchema.optional(),
  }),
});
export type SpeakerEnvelope = z.infer<typeof speakerEnvelopeSchema>;
export const serializeSpeakerEnvelope = (value: SpeakerEnvelope): string =>
  JSON.stringify(speakerEnvelopeSchema.parse(value));
export const guestGrantSchema = z.strictObject({
  artifactId: z.uuid(),
  expiresAt: z.iso.datetime(),
  guestId: id,
  role: z.enum(ARTIFACT_MEMBER_ROLES),
  workspaceId: id,
});
export type GuestGrant = z.infer<typeof guestGrantSchema>;
export interface LiveOperationOrigin {
  changeId: string;
  mode: "direct" | "suggestion";
  participantId: string;
  runId: string;
  toolCallId: string;
}
export interface LiveCheckpoint {
  artifactId: string;
  revision: number;
  versionId: string;
}
export interface LiveRoomRead {
  content: string;
  present: AwarenessEntry[];
  revision: number;
}
/** Concrete operation types belong to the document/deck packages. */
export interface ArtifactRoomContract<TOperation, TRead = LiveRoomRead> {
  applyAgentOps: (
    ops: TOperation[],
    origin: LiveOperationOrigin
  ) => Promise<{ revision: number; changeId: string }>;
  checkpoint: () => Promise<LiveCheckpoint>;
  disconnect: (participantId: string) => Promise<void>;
  presence: () => Promise<AwarenessEntry[]>;
  read: (view: "outline" | "markdown" | "slides") => Promise<TRead>;
  /** Must recheck authorization, not reuse stale claims. */
  refresh: (participantId: string) => Promise<void>;
  restore: (
    versionId: string,
    byParticipant: string
  ) => Promise<LiveCheckpoint>;
  setAgentPresence: (entry: AwarenessEntry | null) => Promise<void>;
}
export interface LiveJoinResult {
  participant: AwarenessEntry;
  role: z.infer<typeof liveRoleSchema>;
  roomUrl: string;
  ticket: string;
}
export interface LiveRoomDirectory<TOperation, TRead = LiveRoomRead> {
  get: (artifactId: string) => ArtifactRoomContract<TOperation, TRead>;
}
export interface LiveCheckpointPort {
  save: (input: {
    workspaceId: string;
    artifactId: string;
    revision: number;
    content: Uint8Array;
  }) => Promise<LiveCheckpoint>;
}

export interface LiveComment {
  authorId: string;
  authorKind: "user" | "guest" | "agent";
  body: string;
  createdAt: string;
  deletedAt: string | null;
  editedAt: string | null;
  id: string;
  runId: string | null;
  threadId: string;
}
export interface LiveCommentThread {
  anchor: CommentAnchor | null;
  answeredAt: string | null;
  artifactId: string;
  comments: LiveComment[];
  id: string;
  quote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  toAgent: boolean;
}
/** TCaller is the authenticated Principal or separately resolved GuestGrant. */
export interface LiveArtifactsContract<TCaller> {
  ask: (
    caller: TCaller,
    input: {
      artifactId: string;
      text: string;
      selection?: z.infer<typeof speakerLocationSchema>;
      agentId?: string;
    }
  ) => Promise<{ runId: string }>;
  comment: (
    caller: TCaller,
    input: {
      artifactId: string;
      anchor?: CommentAnchor;
      threadId?: string;
      body: string;
      toAgent?: boolean;
    }
  ) => Promise<LiveComment>;
  join: (
    caller: TCaller,
    input: { artifactId: string }
  ) => Promise<LiveJoinResult>;
  resolve: (caller: TCaller, input: { threadId: string }) => Promise<void>;
  threads: (
    caller: TCaller,
    input: { artifactId: string; cursor?: string }
  ) => Promise<{ items: LiveCommentThread[]; next?: string }>;
}
