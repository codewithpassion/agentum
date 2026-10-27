/** The charged run, human comment and reply binding are one existing Atomic
 * start transaction. No credential is persisted for a later dispatch. */
import type { Database } from "@repo/db";
import { artifacts as artifactRows } from "@repo/db/schema/artifacts";
import {
  artifactComments,
  artifactCommentThreads,
  guestCommentRuns,
} from "@repo/db/schema/live-artifacts";
import { runs } from "@repo/db/schema/runs";
import type { CommentAnchor } from "@repo/protocol/live";
import { and, eq, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { hashToken } from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import type { createGuestArtifacts, GuestCredential } from "./artifacts.ts";
import type { createGuestAsk } from "./ask.ts";
export const createGuestAddressedComment =
  (deps: {
    db: Database;
    events: Pick<EventsService, "insertStatement">;
    artifacts: Pick<
      ReturnType<typeof createGuestArtifacts>,
      "prepareComment" | "current"
    >;
    ask: ReturnType<typeof createGuestAsk>;
  }) =>
  async (
    input: GuestCredential,
    body: {
      body: string;
      anchor?: CommentAnchor;
      requestId?: string;
      threadId?: string;
    }
  ) => {
    if (!body.requestId || body.threadId) {
      throw new ServiceError(
        "invalid",
        "Addressed comments require a new thread and stable requestId"
      );
    }
    const grant = await deps.artifacts.current(input, true);
    const requestId = `guest-comment:${await hashToken(JSON.stringify([grant.guestId, grant.artifactId, body.requestId]))}`;
    const [previous] = await deps.db
      .select({
        body: artifactComments.body,
        deletedAt: artifactComments.deletedAt,
        threadId: guestCommentRuns.threadId,
      })
      .from(guestCommentRuns)
      .innerJoin(
        runs,
        and(
          eq(runs.id, guestCommentRuns.runId),
          eq(runs.workspaceId, guestCommentRuns.workspaceId)
        )
      )
      .innerJoin(
        artifactComments,
        and(
          eq(artifactComments.id, guestCommentRuns.commentId),
          eq(artifactComments.workspaceId, guestCommentRuns.workspaceId)
        )
      )
      .where(
        and(
          eq(guestCommentRuns.workspaceId, grant.workspaceId),
          eq(guestCommentRuns.artifactId, grant.artifactId),
          eq(runs.requestId, requestId),
          eq(runs.actorKind, "guest"),
          eq(runs.actorId, grant.guestId)
        )
      )
      .limit(1);
    if (
      previous &&
      (previous.body !== body.body.trim() || previous.deletedAt)
    ) {
      throw new ServiceError("conflict", "Comment requestId already used");
    }
    const prepared = previous
      ? null
      : await deps.artifacts.prepareComment(input, body);
    const threadId = previous?.threadId ?? ulid();
    const commentId = ulid();
    const resolved = prepared?.resolved;
    const at = prepared?.at ?? "";
    const started = await deps.ask(
      input,
      { requestId, text: body.body },
      {
        alongside: ({ runId, sessionId }) => [
          deps.db
            .update(artifactRows)
            .set({
              title: sql`case when (select count(*) from artifact_comment_threads where artifact_id=${grant.artifactId} and workspace_id=${grant.workspaceId}) < 1000 then ${artifactRows.title} else null end`,
            })
            .where(
              and(
                eq(artifactRows.id, grant.artifactId),
                eq(artifactRows.workspaceId, grant.workspaceId)
              )
            ),
          deps.db.insert(artifactCommentThreads).values({
            anchor: resolved ? JSON.stringify(resolved.anchor) : null,
            artifactId: grant.artifactId,
            id: threadId,
            quote: resolved?.quote ?? null,
            toAgent: true,
            workspaceId: grant.workspaceId,
          }),
          deps.db.insert(artifactComments).values({
            authorId: grant.guestId,
            authorKind: "guest",
            body: body.body.trim(),
            createdAt: at,
            id: commentId,
            threadId,
            workspaceId: grant.workspaceId,
          }),
          deps.events.insertStatement({
            actor: { id: grant.guestId, kind: "guest" },
            payload: { artifactId: grant.artifactId, commentId, threadId },
            runId,
            sessionId,
            type: "artifact.comment_created",
            workspaceId: grant.workspaceId,
          }),
          deps.db.insert(guestCommentRuns).values({
            artifactId: grant.artifactId,
            commentId,
            runId,
            threadId,
            workspaceId: grant.workspaceId,
          }),
        ],
        threadId,
      }
    );
    const [saved] = await deps.db
      .select({
        body: artifactComments.body,
        id: artifactComments.id,
        threadId: guestCommentRuns.threadId,
      })
      .from(guestCommentRuns)
      .innerJoin(
        artifactComments,
        and(
          eq(artifactComments.id, guestCommentRuns.commentId),
          eq(artifactComments.workspaceId, guestCommentRuns.workspaceId)
        )
      )
      .where(
        and(
          eq(guestCommentRuns.runId, started.runId),
          eq(guestCommentRuns.workspaceId, grant.workspaceId),
          eq(guestCommentRuns.artifactId, grant.artifactId)
        )
      )
      .limit(1);
    if (!saved || saved.body !== body.body.trim()) {
      throw new ServiceError("conflict", "Comment requestId already used");
    }
    return { ...started, id: saved.id, threadId: saved.threadId };
  };
