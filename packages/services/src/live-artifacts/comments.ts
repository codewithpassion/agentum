import type { Statement } from "@repo/db/atomic";
import {
  artifactComments as comments,
  artifactCommentThreads as threads,
} from "@repo/db/schema/live-artifacts";
import {
  LIVE_COMMENT_MAX_BYTES,
  LIVE_COMMENTS_PER_THREAD_MAX,
  LIVE_THREADS_MAX,
} from "@repo/db/shared";
import { type CommentAnchor, commentAnchorSchema } from "@repo/protocol/live";
import { and, asc, count, eq, gt, isNull, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import {
  canComment,
  type InteractionContext,
  invalid,
  missing,
  pageSize,
} from "./shared.ts";

const safeJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const validateComment = (
  input: {
    body: string;
    threadId?: string;
    anchor?: CommentAnchor;
    toAgent?: boolean;
  },
  memberKind: string
) => {
  if (
    !input.body.trim() ||
    new TextEncoder().encode(input.body).length > LIVE_COMMENT_MAX_BYTES
  ) {
    throw invalid("Comment body must be 1 to 4096 bytes");
  }
  if (input.threadId && (input.anchor || input.toAgent)) {
    throw invalid("Replies cannot change thread addressing or anchor");
  }
  if (input.toAgent && memberKind !== "user") {
    throw new ForbiddenError("liveArtifacts.ask");
  }
};

export const createCommentsModule = (ctx: InteractionContext) => {
  const { db, atomic } = ctx;
  const threadAccess = async (principal: Principal, threadId: string) => {
    const [thread] = await db
      .select()
      .from(threads)
      .where(
        and(
          eq(threads.id, threadId),
          eq(
            threads.workspaceId,
            principal.kind === "system" ? "" : principal.workspaceId
          )
        )
      )
      .limit(1);
    if (!thread) {
      throw missing();
    }
    const access = await ctx.access(
      principal,
      thread.artifactId,
      false,
      false,
      false
    );
    if (!["document", "deck"].includes(access.row.kind)) {
      throw missing();
    }
    return { ...access, thread };
  };
  const scope = (row: { id: string; workspaceId: string }) => ({
    artifactId: row.id,
    workspaceId: row.workspaceId,
  });
  const resolveNewAnchor = async (
    row: { id: string; workspaceId: string; kind: string },
    input: { anchor?: CommentAnchor }
  ) => {
    let anchor: CommentAnchor | null = null;
    let quote: string | null = null;
    if (input.anchor) {
      const parsed = commentAnchorSchema.safeParse(input.anchor);
      if (
        !parsed.success ||
        parsed.data.kind !== row.kind ||
        parsed.data.detached
      ) {
        throw invalid("Invalid anchor");
      }
      const resolved = await ctx.anchors.resolve(scope(row), parsed.data);
      anchor = commentAnchorSchema.parse(resolved.anchor);
      ({ quote } = resolved);
      if (
        anchor.kind !== row.kind ||
        anchor.detached ||
        !quote ||
        new TextEncoder().encode(quote).length > LIVE_COMMENT_MAX_BYTES
      ) {
        throw invalid("Anchor does not resolve");
      }
    }
    return { anchor, quote };
  };
  const checkQuota = async (
    principal: Principal,
    row: { id: string; workspaceId: string },
    threadId: string,
    input: { threadId?: string }
  ) => {
    if (input.threadId) {
      const { thread } = await threadAccess(principal, threadId);
      if (thread.artifactId !== row.id) {
        throw missing();
      }
      const [total] = await db
        .select({ n: count() })
        .from(comments)
        .where(
          and(
            eq(comments.threadId, threadId),
            eq(comments.workspaceId, row.workspaceId)
          )
        );
      if ((total?.n ?? 0) >= LIVE_COMMENTS_PER_THREAD_MAX) {
        throw invalid("Comment quota exceeded");
      }
    } else {
      const [total] = await db
        .select({ n: count() })
        .from(threads)
        .where(
          and(
            eq(threads.artifactId, row.id),
            eq(threads.workspaceId, row.workspaceId)
          )
        );
      if ((total?.n ?? 0) >= LIVE_THREADS_MAX) {
        throw invalid("Thread quota exceeded");
      }
    }
  };
  const commitComment = async (
    statements: Statement[],
    principal: Principal,
    row: { id: string; workspaceId: string },
    threadId: string,
    input: { threadId?: string }
  ) => {
    try {
      await atomic(statements);
    } catch (error) {
      try {
        await checkQuota(principal, row, threadId, input);
      } catch {
        // biome-ignore lint/style/useErrorCause: ServiceError has no cause parameter
        throw new ServiceError("conflict", "Comment quota or parent changed");
      }
      throw error;
    }
  };
  return {
    async answered(principal: Principal, input: { threadId: string }) {
      const { member, row, role, thread } = await threadAccess(
        principal,
        input.threadId
      );
      canComment(role);
      if (member.kind !== "run" || !thread.toAgent) {
        throw new ForbiddenError("liveArtifacts.answered");
      }
      const [reply] = await db
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.threadId, thread.id),
            eq(comments.workspaceId, row.workspaceId),
            eq(comments.runId, member.runId),
            eq(comments.authorKind, "agent"),
            isNull(comments.deletedAt)
          )
        )
        .limit(1);
      if (!reply) {
        throw invalid("Reply in the thread before marking answered");
      }
      await atomic([
        db
          .update(threads)
          .set({ answeredAt: ctx.now() })
          .where(
            and(
              eq(threads.id, thread.id),
              eq(threads.workspaceId, row.workspaceId)
            )
          ),
      ]);
    },
    async comment(
      principal: Principal,
      input: {
        artifactId: string;
        threadId?: string;
        body: string;
        anchor?: CommentAnchor;
        toAgent?: boolean;
      }
    ) {
      const { member, row, role } = await ctx.access(
        principal,
        input.artifactId,
        false,
        false,
        false
      );
      if (!["document", "deck"].includes(row.kind)) {
        throw missing();
      }
      canComment(role);
      validateComment(input, member.kind);
      const { anchor, quote } = await resolveNewAnchor(row, input);
      const threadId = input.threadId ?? ulid();
      await checkQuota(principal, row, threadId, input);
      const author = ctx.authorOf(member);
      const comment = {
        authorId: author.id,
        authorKind: author.kind,
        body: input.body,
        createdAt: ctx.now(),
        deletedAt: null,
        editedAt: null,
        id: ulid(),
        runId: author.runId,
        threadId,
        workspaceId: row.workspaceId,
      };
      // Conditional inserts keep quotas bounded even when callers race the preflight.
      const insertComment = db.insert(comments).select(
        db
          .select({
            authorId: sql<string>`${comment.authorId}`.as("authorId"),
            authorKind: sql<"user" | "agent">`${comment.authorKind}`.as(
              "authorKind"
            ),
            body: sql<string>`${comment.body}`.as("body"),
            createdAt: sql<string>`${comment.createdAt}`.as("createdAt"),
            deletedAt: sql<string | null>`NULL`.as("deletedAt"),
            editedAt: sql<string | null>`NULL`.as("editedAt"),
            id: sql<string>`${comment.id}`.as("id"),
            runId: sql<string | null>`${comment.runId}`.as("runId"),
            threadId:
              sql<string>`CASE WHEN (select count(*) from artifact_comments where workspace_id = ${row.workspaceId} and thread_id = ${threadId}) < ${LIVE_COMMENTS_PER_THREAD_MAX} THEN ${threadId} ELSE NULL END`.as(
                "threadId"
              ),
            workspaceId: sql<string>`${comment.workspaceId}`.as("workspaceId"),
          })
          .from(sql`(select 1)`)
      );
      await commitComment(
        [
          ...(input.threadId
            ? []
            : [
                db.insert(threads).select(
                  db
                    .select({
                      anchor: sql<
                        string | null
                      >`${anchor ? JSON.stringify(anchor) : null}`.as("anchor"),
                      answeredAt: sql<string | null>`NULL`.as("answeredAt"),
                      artifactId: sql<string>`${row.id}`.as("artifactId"),
                      id: sql<string>`${threadId}`.as("id"),
                      quote: sql<string | null>`${quote}`.as("quote"),
                      resolvedAt: sql<string | null>`NULL`.as("resolvedAt"),
                      resolvedBy: sql<string | null>`NULL`.as("resolvedBy"),
                      toAgent: sql<boolean>`${input.toAgent ? 1 : 0}`.as(
                        "toAgent"
                      ),
                      workspaceId: sql<string>`${row.workspaceId}`.as(
                        "workspaceId"
                      ),
                    })
                    .from(sql`(select 1)`)
                    .where(
                      sql`(select count(*) from artifact_comment_threads where workspace_id = ${row.workspaceId} and artifact_id = ${row.id}) < ${LIVE_THREADS_MAX}`
                    )
                ),
              ]),
          insertComment,
          ctx.event(member, row, "artifact.comment_created", {
            artifactId: row.id,
            commentId: comment.id,
            threadId,
          }),
        ],
        principal,
        row,
        threadId,
        input
      );
      const [saved] = await db
        .select()
        .from(comments)
        .where(eq(comments.id, comment.id));
      if (!saved) {
        throw new ServiceError("conflict", "Comment quota changed");
      }
      if (input.toAgent) {
        await ctx.ask.startComment(principal, {
          ...scope(row),
          commentId: comment.id,
          text: input.body,
          threadId,
        });
      }
      return saved;
    },
    async resolve(principal: Principal, input: { threadId: string }) {
      const { member, row, role, thread } = await threadAccess(
        principal,
        input.threadId
      );
      canComment(role);
      if (member.kind === "run") {
        throw new ForbiddenError("liveArtifacts.resolve");
      }
      if (thread.resolvedAt) {
        return;
      }
      await atomic([
        db
          .update(threads)
          .set({ resolvedAt: ctx.now(), resolvedBy: ctx.participantId(member) })
          .where(
            and(
              eq(threads.id, thread.id),
              eq(threads.workspaceId, row.workspaceId),
              isNull(threads.resolvedAt)
            )
          ),
        ctx.event(
          member,
          row,
          "artifact.comment_resolved",
          {
            artifactId: row.id,
            threadId: thread.id,
          },
          sql`changes() = 1`
        ),
      ]);
    },
    async threads(
      principal: Principal,
      input: {
        artifactId: string;
        cursor?: string;
        limit?: number;
        inbox?: boolean;
      }
    ) {
      const { row } = await ctx.access(
        principal,
        input.artifactId,
        false,
        false,
        false
      );
      if (!["document", "deck"].includes(row.kind)) {
        throw missing();
      }
      const limit = pageSize(input.limit);
      const rows = await db
        .select()
        .from(threads)
        .where(
          and(
            eq(threads.workspaceId, row.workspaceId),
            eq(threads.artifactId, row.id),
            input.cursor ? gt(threads.id, input.cursor) : undefined,
            input.inbox
              ? and(
                  eq(threads.toAgent, true),
                  isNull(threads.answeredAt),
                  isNull(threads.resolvedAt)
                )
              : undefined
          )
        )
        .orderBy(asc(threads.id))
        .limit(limit + 1);
      const items = await Promise.all(
        rows.slice(0, limit).map(async (thread) => {
          let anchor: CommentAnchor | null = null;
          if (thread.anchor) {
            const parsed = commentAnchorSchema.safeParse(
              safeJson(thread.anchor)
            );
            if (parsed.success) {
              try {
                anchor = commentAnchorSchema.parse(
                  (await ctx.anchors.resolve(scope(row), parsed.data)).anchor
                );
              } catch {
                anchor = { ...parsed.data, detached: true };
              }
            }
          }
          return {
            ...thread,
            anchor,
            comments: await db
              .select()
              .from(comments)
              .where(
                and(
                  eq(comments.workspaceId, row.workspaceId),
                  eq(comments.threadId, thread.id),
                  isNull(comments.deletedAt)
                )
              )
              .orderBy(asc(comments.id))
              .limit(LIVE_COMMENTS_PER_THREAD_MAX),
          };
        })
      );
      return {
        items,
        ...(rows.length > limit ? { next: items.at(-1)?.id } : {}),
      };
    },
  };
};
