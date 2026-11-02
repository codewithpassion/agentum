/**
 * What an app artifact's server code may reach, read from its version's grants
 * (phase 2). Hosts and secret names come from `artifact_grants`; the secret
 * values come from the workspace secrets service, by name.
 */

import type { Database } from "@repo/db";
import {
  approvedGrantTargets,
  hasGrantOfKind,
  versionWorkspaceId,
  workspaceClerkOrgId,
} from "@repo/db/artifact-app";
import type { ProxyMatch, SecretsService } from "../secrets.ts";
import type { Principal } from "../workspaces.ts";

export interface AppGrantsDeps {
  db: Database;
  /** Whether a user is in a Clerk org right now, with no cache. Without it, no member call runs. */
  isOrgMember?: (userId: string, clerkOrgId: string) => Promise<boolean>;
  secrets: Pick<SecretsService, "proxyForNames">;
}

export const createAppGrantsService = ({
  db,
  isOrgMember,
  secrets,
}: AppGrantsDeps) => {
  /** The hosts a person approved for the version. */
  const approvedHosts = (versionId: string): Promise<string[]> =>
    approvedGrantTargets(db, { kind: "host", versionId });

  /** Whether the version asked for any host, approved or not. */
  const declaresHosts = (versionId: string): Promise<boolean> =>
    hasGrantOfKind(db, { kind: "host", versionId });

  /** The header rules of the version's approved secrets that apply to `host`. */
  const secretRules = async (
    workspaceId: string,
    versionId: string,
    host: string
  ): Promise<ProxyMatch[]> => {
    const names = await approvedGrantTargets(db, {
      kind: "secret",
      versionId,
    });
    if (names.length === 0) {
      return [];
    }
    return await secrets.proxyForNames(workspaceId, names, host);
  };

  /**
   * The user principal for a member whose page or app server calls a tool.
   * The view token is minutes old, so membership is asked again, uncached:
   * null when the workspace has no row, or the
   * person has left the org. Admin rights are not carried, so a private
   * artifact of someone else stays closed to an admin's app calls.
   */
  const memberPrincipal = async (
    userId: string,
    workspaceId: string
  ): Promise<Extract<Principal, { kind: "user" }> | null> => {
    const clerkOrgId = await workspaceClerkOrgId(db, workspaceId);
    if (
      !(clerkOrgId && isOrgMember && (await isOrgMember(userId, clerkOrgId)))
    ) {
      return null;
    }
    return { kind: "user", userId, via: "session", workspaceId };
  };

  return {
    approvedHosts,
    declaresHosts,
    memberPrincipal,
    secretRules,
    versionWorkspaceId: (
      artifactId: string,
      versionId: string
    ): Promise<string | null> =>
      versionWorkspaceId(db, { artifactId, versionId }),
  };
};

export type AppGrantsService = ReturnType<typeof createAppGrantsService>;
