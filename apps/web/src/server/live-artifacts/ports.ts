import type {
  LiveOperationOrigin,
  RelativePositionJSON,
  RoomTicketClaims,
} from "@repo/protocol/live";

export interface RoomScope {
  artifactId: string;
  workspaceId: string;
}
export interface RoomSnapshot {
  revision: number;
  state: Uint8Array;
}
export type RoomIdentity = Pick<
  RoomTicketClaims,
  "participantId" | "kind" | "role" | "name" | "color"
> & {
  /** Opaque server-side credential/session reference, persisted in socket attachments. */
  authorizationRef: string;
};
export interface RestoreProvenance {
  byParticipant: string;
  requestId: string;
  versionId: string;
}
export type RoomAdmissionContext =
  | { request: Request }
  | { authorizationRef: string };
/** Trusted in-process/service-binding adapter only. Never expose these methods as public routes. */
export interface ArtifactRoomService {
  /** Resolve fresh authenticated principal and call LiveAdmissionPort.admit. Never derive a privileged principal from claims. */
  admit: (
    scope: RoomScope,
    ticket: string,
    context: RoomAdmissionContext
  ) => Promise<RoomIdentity | null>;
  /** Read current membership, artifact deletion, principal restrictions and grant expiry.
   * Return null for revoked/deleted access. Must not authorize from ticket claims alone.
   * The adapter must serialize with access mutations or use a current access generation.
   */
  authorize: (
    scope: RoomScope,
    subject: Pick<RoomIdentity, "participantId" | "kind"> & {
      authorizationRef?: string;
    }
  ) => Promise<RoomIdentity | null>;
  /** Resolve the namespace object ID to its immutable scope and authorized initial checkpoint. */
  open: (objectId: string) => Promise<RoomScope & RoomSnapshot>;
  /** URLs verified as this artifact/workspace's own blobs; never accept a browser policy. */
  ownBlobUrls: (scope: RoomScope) => Promise<string[]>;
  /** Current active document comment ranges, resolved inside the serialized agent mutation. */
  protectedRanges: (
    scope: RoomScope
  ) => Promise<
    Array<{ start: RelativePositionJSON; end: RelativePositionJSON }>
  >;
  /** Idempotent by checkpointId. Reconcile a service restore save that already committed.
   * Atomically persist revision, provenance/events and attribution; acknowledge only after commit.
   * Background saves must resolve an authorized principal, not impersonate a workspace ID.
   */
  save: (
    scope: RoomScope,
    input: RoomSnapshot & {
      checkpointId: string;
      restores: RestoreProvenance[];
      origins: LiveOperationOrigin[];
    }
  ) => Promise<{ versionId: string; revision: number }>;
}
/** Deliberately separate from generated production Env until L.7 supplies adapters/bindings. */
export interface ArtifactRoomEnv {
  ARTIFACT_ROOM_SERVICE: ArtifactRoomService;
  ARTIFACT_ROOM_TICKET_KEY: string;
}
