/** Guest HTTP client contracts. Credentials travel only in the HttpOnly cookie.
 * Fetch with credentials: same-origin and Origin on mutations; serialize cookie
 * rotating HTTP requests (a concurrent use of an old credential is refused).
 * Guest image URLs are the artifact-scoped guestUrl, canonical document state
 * retains /files/:id. Guest asks require a composed, configured restricted cloud executor; unsupported runtimes stay unavailable. No guest approval/export endpoint exists.
 */
import { z } from "zod";
import {
  commentAnchorSchema,
  type GuestGrant,
  type LiveJoinResult,
  type LiveSuggestion,
} from "./live.ts";
export const guestAskSchema = z.strictObject({
  agentId: z.string().min(1).max(200).optional(),
  requestId: z.string().min(1).max(200),
  text: z.string().trim().min(1).max(16_000),
});
export interface GuestAskResult {
  runId: string;
  sessionId: string;
  status: string;
}
export const guestVerifySchema = z.strictObject({ code: z.string().max(100) });
export const guestCommentSchema = z.strictObject({
  anchor: commentAnchorSchema.optional(),
  body: z.string().trim().min(1).max(4096),
  requestId: z.string().min(1).max(200).optional(),
  threadId: z.string().min(1).max(200).optional(),
  toAgent: z.boolean().optional(),
});
export interface GuestVerifyResult {
  expiresAt: string;
  grant: GuestGrant;
  location: string;
}
export interface GuestOpenResult {
  grant: GuestGrant;
  guestName: string;
  inviterName: string;
  kind: "document" | "deck";
  revision: number;
  state: number[];
  title: string;
  workspaceName: string;
}
export type GuestJoinResult = LiveJoinResult;
export interface GuestImageResult {
  guestUrl: string;
  url: string;
}
export const guestEndpoints = {
  artifact: (
    id: string,
    action:
      | "suggestions"
      | "decide-suggestion"
      | "invitations"
      | "ask"
      | "ask-availability"
      | "open"
      | "join"
      | "rotate"
      | "threads"
      | "comment"
      | "resolve"
      | "policy"
      | "images"
      | "embed"
      | "ensure-deck-cell"
      | "room"
      | "session"
  ) => `/api/guest/artifacts/${encodeURIComponent(id)}/${action}`,
  code: (token: string) => `/api/guest/${encodeURIComponent(token)}/code`,
  image: (id: string, file: string) =>
    `/api/guest/artifacts/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`,
  invitation: (token: string) => `/g/${encodeURIComponent(token)}`,
  signout: "/api/guest/signout",
  stream: (id: string) =>
    `/api/guest/artifacts/${encodeURIComponent(id)}/session/stream`,
  verify: (token: string) => `/api/guest/${encodeURIComponent(token)}/verify`,
} as const;

/** Read results are intentionally restricted to this artifact's own threads. */
export interface GuestCommentResult {
  id: string;
  threadId: string;
}
export interface GuestThreadComment {
  authorId: string;
  authorKind: "user" | "guest" | "agent";
  body: string;
  createdAt: string;
  deletedAt: string | null;
  editedAt: string | null;
  id: string;
  runId: string | null;
  threadId: string;
  workspaceId: string;
}
export interface GuestThread {
  anchor: string | null;
  answeredAt: string | null;
  artifactId: string;
  comments: GuestThreadComment[];
  id: string;
  quote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  toAgent: boolean;
  workspaceId: string;
}
export interface GuestPolicyResult {
  ownBlobUrls: string[];
  ranges: Array<{
    start: import("./live.ts").RelativePositionJSON;
    end: import("./live.ts").RelativePositionJSON;
  }>;
}
export interface GuestLandingResult {
  artifactTitle: string;
  expiresAt: string | null;
  inviterName: string;
  role: GuestGrant["role"];
  workspaceName: string;
}
export interface GuestSessionEvent {
  actor: { id: string; kind: import("@repo/db/shared").EventActorKind };
  actorDisplay?: { name: string };
  agentId: string | null;
  createdAt: string;
  id: string;
  payload: unknown;
  payloadRef: string | null;
  runId: string | null;
  seq: number | null;
  sessionId: string | null;
  type: import("@repo/db/shared").EventType;
  workspaceId: string;
}
export interface GuestSessionResult {
  events: GuestSessionEvent[];
  sessionId: string | null;
}

export interface GuestSuggestionsResult {
  items: LiveSuggestion[];
  mode: boolean;
}

/** Server-selected agent and authenticated room location, never caller overrides. */
export interface GuestAskAvailability {
  agent?: { id: string; name: string };
  available: boolean;
  role: GuestGrant["role"];
  where?: import("./live.ts").SpeakerEnvelope["harbourmaster_turn"]["where"];
}
