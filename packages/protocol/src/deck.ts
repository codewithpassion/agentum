import { z } from "zod";
import type { AwarenessEntry } from "./live";

export const PRESENTER_LEASE_MS = 15_000;
/** Error reason the deck room sends when an update builds on history compaction removed. */
export const DECK_STALE_ANCESTRY = "deck_stale_ancestry";
const id = z.string().min(1).max(200);
export const presentationControlSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("acquire"),
    build: z.int().min(0).max(10_000),
    requestId: id,
    slideId: id,
    type: z.literal("presentation"),
  }),
  z.strictObject({
    action: z.literal("position"),
    build: z.int().min(0).max(10_000),
    leaseId: id,
    requestId: id,
    slideId: id,
    type: z.literal("presentation"),
  }),
  z.strictObject({
    action: z.literal("renew"),
    leaseId: id,
    requestId: id,
    type: z.literal("presentation"),
  }),
  z.strictObject({
    action: z.literal("release"),
    leaseId: id,
    requestId: id,
    type: z.literal("presentation"),
  }),
]);
export type PresentationControl = z.infer<typeof presentationControlSchema>;
export interface TrustedPresentationPosition {
  build: number;
  presenterId: string;
  slideId: string;
}
export interface PresentationBroadcast {
  position: TrustedPresentationPosition | null;
  type: "presentation";
}
export interface PresentationResult {
  expiresAt?: number;
  leaseId?: string;
  ok: boolean;
  reason?: string;
  requestId: string;
  type: "presentation-result";
}
/** Session precedes Yjs sync step1. Client responds with sync step1 and completes
 * sync step2 before enabling editor. Error/4001 requires a NEW replica, never
 * merge rejected optimistic structs back. Rejoin obtains a fresh one-use ticket. */
export interface DeckRoomSession {
  awarenessId: number;
  epoch: string;
  expiresAt: number;
  kind: "deck";
  /** Legacy field name: includes image paths and authorized immutable artifact embed identities. */
  ownBlobUrls: string[];
  participant: Pick<AwarenessEntry, "id" | "kind" | "name" | "color">;
  role: "owner" | "editor" | "commenter" | "viewer";
  type: "session";
}

/** Allocate a sparse table cell only on the serialized authority. Apply returned
 * admitted state before binding a client editor; never locally create the key. */
export const ensureDeckCellInputSchema = z.strictObject({
  artifactId: z.uuid(),
  elementId: z.string().min(1).max(80),
  key: z
    .string()
    .regex(/^(0|[1-9]\d*):(0|[1-9]\d*)$/)
    .max(20),
  slideId: z.string().min(1).max(80),
});
export type EnsureDeckCellInput = z.infer<typeof ensureDeckCellInputSchema>;
export interface EnsureDeckCellResult {
  revision: number;
  state: number[];
}

const embedSourcePattern =
  /^artifact:([0-9a-f-]{36}):([A-Za-z0-9_-]{1,80}):([0-9a-f]{64}):([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\.html)$/;
/** Persistent identity, never a URL or a bearer token. Authorization is supplied by the host. */
export function parseEmbedSource(source: string | undefined): {
  artifactId: string;
  versionId: string;
  sha256: string;
  path: string;
} | null {
  if (typeof source !== "string" || source.length > 1200) {
    return null;
  }
  const match = embedSourcePattern.exec(source);
  if (!match) {
    return null;
  }
  const [, artifactId, versionId, sha256, path] = match;
  if (
    !(artifactId && versionId && sha256 && path) ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    return null;
  }
  return { artifactId, path, sha256, versionId };
}
