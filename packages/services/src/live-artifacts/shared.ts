import type { RoomTicketClaims } from "@repo/protocol/live";
import type { SQL } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import type { LiveArtifactsDeps, Member, Row } from "./service.ts";
export interface InteractionContext extends LiveArtifactsDeps {
  access: (
    principal: Principal,
    artifactId: string,
    write?: boolean,
    owner?: boolean,
    live?: boolean
  ) => Promise<{ member: Member; row: Row; role: RoomTicketClaims["role"] }>;
  authorOf: (member: Member) => {
    id: string;
    kind: "user" | "agent";
    runId: string | null;
    agentId: string | null;
  };
  event: (
    member: Member,
    row: Row,
    type:
      | "artifact.comment_created"
      | "artifact.comment_resolved"
      | "artifact.agent_change_reverted"
      | "artifact.deleted"
      | "artifact.audience_changed",
    payload: Record<string, unknown>,
    condition?: SQL
  ) => ReturnType<LiveArtifactsDeps["events"]["insertStatement"]>;
  now: () => string;
  participantId: (member: Member) => string;
}
export const missing = () =>
  new ServiceError("not_found", "Thread or change not found");
export const invalid = (message: string) =>
  new ServiceError("invalid", message);
export const canComment = (role: RoomTicketClaims["role"]) => {
  if (role === "viewer") {
    throw new ForbiddenError("liveArtifacts.comment");
  }
};
export const pageSize = (limit = 50) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw invalid("Invalid page size");
  }
  return limit;
};
