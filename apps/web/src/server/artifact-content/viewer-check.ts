// Whether the person or link a view token names is still allowed in. The
// token is an hour old at most, so a link's share row is read again on each
// content request (no cache) and a revoke takes effect at once. Membership is
// a Clerk call, so a "yes" is kept for a minute: a removed member is out
// within 60 seconds, and a page with many files does not call Clerk per file.

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
  // A member's token, and a proposed version's test token, both name the person.
  if (claims.userId) {
    return ports.isMember(claims.userId, claims.workspaceId);
  }
  return Promise.resolve(true);
};

const MEMBER_TTL_MS = 60_000;
const memberYes = new Map<string, number>();

/** The two reads, backed by the share and app-grant services. Read-only. */
export const viewerPorts = (
  composed: {
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
  },
  now: () => number = Date.now
): ViewerCheckPorts => ({
  isMember: async (userId, workspaceId) => {
    const key = `${userId}\n${workspaceId}`;
    const until = memberYes.get(key);
    if (until !== undefined && until > now()) {
      return true;
    }
    const member =
      (await composed.services.artifactApp.memberPrincipal(
        userId,
        workspaceId
      )) !== null;
    if (member) {
      memberYes.set(key, now() + MEMBER_TTL_MS);
    } else {
      memberYes.delete(key);
    }
    return member;
  },
  isShareLive: async (shareId, artifactId) =>
    (await composed.services.artifactShares.shareState(shareId, artifactId)).ok,
});
