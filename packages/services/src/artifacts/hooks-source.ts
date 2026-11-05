import type { Database } from "@repo/db";
import { hasGrantOfKind, versionWorkspaceId } from "@repo/db/artifact-app";
import { ensureViewSalt } from "@repo/db/artifact-shares";
import {
  cutUserAgent,
  newSalt,
  truncateIp,
  utcDay,
  visitorHash,
} from "./view-privacy.ts";

/** The front's narrow data adapter: no secrets, tools, auth provider or run runtime. */
export const createHooksSource = ({
  db,
  clock,
}: {
  db: Database;
  clock: { now: () => Date };
}) => ({
  declaresHosts: (versionId: string) =>
    hasGrantOfKind(db, { kind: "host", versionId }),
  requestMeta: async (request: Request, workspaceId: string) => {
    const ip = request.headers.get("CF-Connecting-IP");
    const agent = request.headers.get("User-Agent");
    const { cf } = request as { cf?: { country?: string } };
    return {
      ipPrefix: ip ? truncateIp(ip) : null,
      place: cf?.country || null,
      userAgent: cutUserAgent(agent),
      visitorHash: ip
        ? await visitorHash(
            await ensureViewSalt(
              db,
              workspaceId,
              utcDay(clock.now()),
              newSalt()
            ),
            ip,
            agent ?? ""
          )
        : "",
    };
  },
  versionWorkspaceId: (artifactId: string, versionId: string) =>
    versionWorkspaceId(db, { artifactId, versionId }),
});
