// Whether the person or link a view token names is still allowed in. The
// token is an hour old at most, so the share row and the membership are read
// again on each content request (no cache), and a revoke takes effect at once.

import type { ViewTokenClaims } from "@repo/protocol/artifacts";

export interface ViewerCheckPorts {
  /** True while the person still belongs to the workspace's organisation. */
  isMember: (userId: string, workspaceId: string) => Promise<boolean>;
  /** True while the share is neither revoked, expired, nor switched off. */
  isShareLive: (shareId: string, artifactId: string) => Promise<boolean>;
}

export const viewerStillAllowed = (
  claims: ViewTokenClaims,
  ports: ViewerCheckPorts
): Promise<boolean> => {
  if (claims.shareId) {
    return ports.isShareLive(claims.shareId, claims.artifactId);
  }
  if (claims.viewer === "member" && claims.userId) {
    return ports.isMember(claims.userId, claims.workspaceId);
  }
  return Promise.resolve(true);
};

/** The two reads, backed by the share and app-grant services. Read-only. */
export const viewerPorts = (composed: {
  services: {
    artifactApp: {
      memberPrincipal: (
        userId: string,
        workspaceId: string
      ) => Promise<unknown>;
    };
    artifactShares: {
      shareState: (
        shareId: string,
        artifactId: string
      ) => Promise<{ ok: boolean }>;
    };
  };
}): ViewerCheckPorts => ({
  isMember: async (userId, workspaceId) =>
    (await composed.services.artifactApp.memberPrincipal(
      userId,
      workspaceId
    )) !== null,
  isShareLive: async (shareId, artifactId) =>
    (await composed.services.artifactShares.shareState(shareId, artifactId)).ok,
});
