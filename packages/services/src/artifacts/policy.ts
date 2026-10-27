/**
 * Who may open, manage, link and update an artifact (PRD R1.5, R1.6, R1.9).
 * Pure functions over plain records: no principal and no database, so the
 * caller loads the artifact and the user, and passes them in.
 */

import type { ArtifactAudience } from "@repo/db/shared";

export interface ArtifactPolicyRecord {
  /** The agent that made the artifact. */
  agentId: string | null;
  audience: ArtifactAudience;
  /** The agent the artifact was handed to (phase 2 hand-over). */
  handedToAgentId: string | null;
  /** The person who owns it. Null when a routine made it. */
  ownerUserId: string | null;
}

export interface PolicyUser {
  isAdmin: boolean;
  userId: string;
}

export interface PolicySession {
  origin: string;
  private: boolean;
}

/**
 * The audience of an artifact published from `session`. A person publishing
 * outside a session gets `private`, as does anything from the `ui` origin or a
 * private session. Every other session publishes to the workspace.
 */
export const defaultAudience = (
  session: PolicySession | null
): ArtifactAudience => {
  if (session === null || session.private || session.origin === "ui") {
    return "private";
  }
  return "workspace";
};

const isOwner = (artifact: ArtifactPolicyRecord, user: PolicyUser): boolean =>
  artifact.ownerUserId !== null && artifact.ownerUserId === user.userId;

/** Workspace artifacts open for every member. Private ones open for the owner and admins. */
export const canOpen = (
  artifact: ArtifactPolicyRecord,
  user: PolicyUser
): boolean =>
  artifact.audience === "workspace" || isOwner(artifact, user) || user.isAdmin;

/** The owner, or an admin. An artifact with no owner is managed by admins only. */
export const canManage = (
  artifact: ArtifactPolicyRecord,
  user: PolicyUser
): boolean => isOwner(artifact, user) || user.isAdmin;

/** Only the owner. An admin who is not the owner cannot create a live link. */
export const canCreateLiveLink = (
  artifact: ArtifactPolicyRecord,
  user: PolicyUser
): boolean => isOwner(artifact, user);

/**
 * A run sees workspace artifacts, and those its agent made or was handed. A
 * null agent id matches nothing.
 */
export const agentCanSee = (
  artifact: ArtifactPolicyRecord,
  agentId: string | null
): boolean =>
  artifact.audience === "workspace" ||
  (agentId !== null &&
    (artifact.agentId === agentId || artifact.handedToAgentId === agentId));

/**
 * A run may update only an artifact its agent made or was handed. A null
 * agent id on either side never matches.
 */
export const agentCanUpdate = (
  artifact: ArtifactPolicyRecord,
  agentId: string | null
): boolean =>
  agentId !== null &&
  (artifact.agentId === agentId || artifact.handedToAgentId === agentId);
