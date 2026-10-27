import type { CommentAnchor, RoomTicketClaims } from "@repo/protocol/live";
import type { Principal } from "../workspaces.ts";
import type { DocumentSnapshot, LiveRoomScope } from "./service.ts";

/** Resolve relative positions against current room state, never offsets or quote search. */
export interface LiveAnchorPort {
  /** Reject agent snapshots deleting any currently anchored words. The room
   * must validate against its current revision atomically with the edit. */
  guardAgentSnapshot: (
    scope: LiveRoomScope,
    input: { snapshot: DocumentSnapshot; runId: string }
  ) => Promise<void>;
  resolve: (
    scope: LiveRoomScope,
    anchor: CommentAnchor
  ) => Promise<{
    anchor: CommentAnchor;
    quote: string | null;
  }>;
}
export interface LiveAskPort {
  startComment: (
    principal: Principal,
    input: LiveRoomScope & {
      threadId: string;
      commentId: string;
      text: string;
    }
  ) => Promise<{ runId: string }>;
}
/** Room must scope UndoManager to change origin, preserve later human edits and
 * reject operations deleting anchored words. changeId is the idempotency key:
 * retry after a DB failure must return the same successful result. */
export interface LiveChangePort {
  revert: (
    scope: LiveRoomScope,
    input: {
      changeId: string;
      runId: string;
      toolCallId: string;
      revFrom: number;
      revTo: number;
      byParticipant: string;
    }
  ) => Promise<{ revision: number }>;
}
export interface LiveInteractionPorts {
  anchors: LiveAnchorPort;
  ask: LiveAskPort;
  changes: LiveChangePort;
}

/** Trusted room adapter calls this with a freshly resolved current principal,
 * never a principal reconstructed solely from ticket role/name. */
export interface LiveAdmissionPort {
  admit: (
    principal: Principal,
    input: { artifactId: string; ticket: string }
  ) => Promise<RoomTicketClaims>;
}
