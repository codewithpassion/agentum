/**
 * The artifacts and run behind each post of an inbox thread, as one reader may
 * see them. A post keeps its files and its run only while the reader may see
 * that run, so a shared post never reveals a run in another person's ui session
 * or a private one. Artifacts of the run follow their own audience.
 */
import type { Database } from "@repo/db";
import { artifacts, artifactVersions } from "@repo/db/schema/artifacts";
import { inboxPosts } from "@repo/db/schema/inbox";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { and, asc, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import {
  type ArtifactPolicyRecord,
  agentCanSee,
  canOpen,
} from "../artifacts/policy.ts";
import { visibleSessions } from "../sessions.ts";
import type { Principal } from "../workspaces.ts";

export interface ArtifactLink {
  id: string;
  title: string;
}

export interface PostLinks {
  artifacts: ArtifactLink[];
  fileIds: string[];
  runId: string | null;
}

export type LinkReader = Extract<Principal, { kind: "user" | "run" }>;

interface LinkPost {
  fileIds: string[];
  id: string;
  runId: string | null;
}

/**
 * The ids of the runs in the reader's workspace that wrote one of the thread's
 * posts and whose session the reader may see. Returns the query itself, not its
 * rows, so the caller can run it or nest it in another query. Not async: an
 * async function would run a returned query builder.
 */
const visibleRunIdsOf = (
  db: Database,
  reader: LinkReader,
  threadId: string,
  sessionFilter: SQL | undefined
) =>
  db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.workspaceId, reader.workspaceId),
        inArray(
          runs.sessionId,
          db.select({ id: sessions.id }).from(sessions).where(sessionFilter)
        ),
        inArray(
          runs.id,
          db
            .select({ runId: inboxPosts.runId })
            .from(inboxPosts)
            .where(eq(inboxPosts.threadId, threadId))
        )
      )
    );

type VisibleRunIds = ReturnType<typeof visibleRunIdsOf>;

/** Whether the reader may open an artifact by its own audience rule. */
const mayReadArtifact = (
  reader: LinkReader,
  record: ArtifactPolicyRecord
): boolean =>
  reader.kind === "user"
    ? canOpen(record, {
        isAdmin: reader.isAdmin === true,
        userId: reader.userId,
      })
    : agentCanSee(record, reader.agentId);

/**
 * The artifacts each visible run wrote a version of, keyed by run id. An
 * artifact appears once per run however many versions the run wrote.
 */
const artifactLinksByRun = async (
  db: Database,
  reader: LinkReader,
  visibleRunIds: VisibleRunIds
): Promise<Map<string, ArtifactLink[]>> => {
  const rows = await db
    .selectDistinct({
      agentId: artifacts.agentId,
      audience: artifacts.audience,
      handedToAgentId: artifacts.handedToAgentId,
      id: artifacts.id,
      ownerUserId: artifacts.ownerUserId,
      runId: artifactVersions.authorRunId,
      title: artifacts.title,
      updatedAt: artifacts.updatedAt,
    })
    .from(artifacts)
    .innerJoin(artifactVersions, eq(artifactVersions.artifactId, artifacts.id))
    .where(
      and(
        eq(artifacts.workspaceId, reader.workspaceId),
        isNull(artifacts.deletedAt),
        inArray(artifactVersions.authorRunId, visibleRunIds)
      )
    )
    .orderBy(desc(artifacts.updatedAt), asc(artifacts.id));

  const linksByRun = new Map<string, ArtifactLink[]>();
  for (const row of rows) {
    if (row.runId === null || !mayReadArtifact(reader, row)) {
      continue;
    }
    const links = linksByRun.get(row.runId) ?? [];
    links.push({ id: row.id, title: row.title });
    linksByRun.set(row.runId, links);
  }
  return linksByRun;
};

const linksOf = (
  post: LinkPost,
  visibleRunIds: ReadonlySet<string>,
  linksByRun: ReadonlyMap<string, ArtifactLink[]>
): PostLinks => {
  if (post.runId === null) {
    return { artifacts: [], fileIds: post.fileIds, runId: null };
  }
  if (!visibleRunIds.has(post.runId)) {
    return { artifacts: [], fileIds: [], runId: null };
  }
  return {
    artifacts: linksByRun.get(post.runId) ?? [],
    fileIds: post.fileIds,
    runId: post.runId,
  };
};

/** The links of each post in a thread, keyed by post id, as `reader` may see them. */
export const postLinks = async (
  db: Database,
  reader: LinkReader,
  threadId: string,
  posts: readonly LinkPost[]
): Promise<Map<string, PostLinks>> => {
  const sessionFilter = await visibleSessions(db, reader);
  const visibleRunIds = visibleRunIdsOf(db, reader, threadId, sessionFilter);
  const visibleIds = new Set((await visibleRunIds).map((run) => run.id));
  const linksByRun = await artifactLinksByRun(db, reader, visibleRunIds);
  return new Map(
    posts.map((post) => [post.id, linksOf(post, visibleIds, linksByRun)])
  );
};
