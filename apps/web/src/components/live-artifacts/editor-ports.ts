import type { ContentPolicy } from "@repo/live-doc/schema";
import type { RelativePositionJSON } from "@repo/protocol/live";
import type { ReactNode } from "react";
import type { Awareness } from "y-protocols/awareness";
import type { Doc } from "yjs";

export type EditorRole = "owner" | "editor" | "commenter" | "viewer";
/** Supplied by authenticated room membership, never copied from awareness.user. */
export interface TrustedParticipant {
  clientId: number;
  color: string;
  id: string;
  kind: "member" | "guest" | "agent";
  name: string;
  status?: { text: string; updatedAt: number };
}
export interface PresencePort {
  awareness: Awareness;
  /** Stable snapshot until subscribe fires. Includes the local participant. */
  getSnapshot: () => readonly TrustedParticipant[];
  subscribe: (listener: () => void) => () => void;
  /** Mount only after initial room content and verified blob manifest are synchronized. */
  synced: true;
}
export interface EditorSelection {
  end: RelativePositionJSON;
  start: RelativePositionJSON;
  text: string;
}
export interface AgentDecoration extends EditorSelection {
  id: string;
  name: string;
}
export interface Checkpoint {
  createdAt: string;
  id: string;
  label: string;
}
export interface HistoryPort {
  /** Export the latest persisted checkpoint, not a speculative local snapshot. */
  downloadMarkdown: () => Promise<{ filename: string; markdown: string }>;
  list: () => Promise<readonly Checkpoint[]>;
  /** Server restores as a new room edit; never replace the browser's Y.Doc. */
  restore: (id: string) => Promise<void>;
}
export interface DocumentEditorPorts {
  agentChanges?: readonly AgentDecoration[];
  document: Doc;
  history: HistoryPort;
  onAskAgent: (selection: EditorSelection) => void;
  onCommentSelection: (selection: EditorSelection) => void;
  policy: ContentPolicy;
  provider: PresencePort;
  role: EditorRole;
  sidebar?: ReactNode;
  /** Must persist/validate ownership and return a same-origin /files path. */
  uploadImage: (file: File) => Promise<{ url: string; alt: string }>;
}
export const canEdit = (role: EditorRole) =>
  role === "owner" || role === "editor";

/** Refresh every 500ms, allowing stale agent presence to clear within five seconds. */
export const AGENT_PRESENCE_TTL_MS = 4500;
