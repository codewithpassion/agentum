/** Comment effects are scoped like artifact reads, not editor-only mutations.
 * The effect receipt and comment/answered state commit in one Atomic write. */
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import {
  artifactComments as comments,
  guestCommentEffects,
  guestCommentRuns,
  artifactCommentThreads as threads,
} from "@repo/db/schema/live-artifacts";
import { runs as runRows } from "@repo/db/schema/runs";
import { LIVE_COMMENTS_PER_THREAD_MAX } from "@repo/db/shared";
import { type CommentAnchor, commentAnchorSchema } from "@repo/protocol/live";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { hashToken } from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import { currentGuestRun, guestUnavailable } from "../runs/guest-scope.ts";
import type { Clock } from "../runs/types.ts";
import type { RunsService } from "../runs.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { createGuestRunAccess } from "./run-access.ts";

const schema = z.object({
  answered: z.literal(true).optional(),
  artifactId: z.string(),
  body: z
    .string()
    .trim()
    .min(1)
    .refine((v) => new TextEncoder().encode(v).length <= 4096)
    .optional(),
  threadId: z.string().optional(),
  to: z.never().optional(),
});
export const createScopedGuestComments = (deps: {
  db: Database;
  events: Pick<EventsService, "insertStatement">;
  atomic: Atomic;
  clock: Clock;
  guestsOff: () => boolean;
  runs: Pick<RunsService, "authorizeScopedRun" | "guestExecution">;
}) => {
  const access = createGuestRunAccess(deps);
  const replay = async (runId: string, callId: string, fingerprint: string) => {
    const [saved] = await deps.db
      .select()
      .from(guestCommentEffects)
      .where(
        and(
          eq(guestCommentEffects.runId, runId),
          eq(guestCommentEffects.callId, callId)
        )
      )
      .limit(1);
    if (saved && saved.fingerprint !== fingerprint) {
      throw new ServiceError("conflict", "Comment effect id already used");
    }
    return saved;
  };
  const result = async (saved: typeof guestCommentEffects.$inferSelect) => {
    const [thread] = await deps.db
      .select()
      .from(threads)
      .where(
        and(
          eq(threads.id, saved.threadId),
          eq(threads.workspaceId, saved.workspaceId)
        )
      )
      .limit(1);
    const [comment] = saved.commentId
      ? await deps.db
          .select()
          .from(comments)
          .where(
            and(
              eq(comments.id, saved.commentId),
              eq(comments.workspaceId, saved.workspaceId)
            )
          )
          .limit(1)
      : [];
    if (!thread) {
      throw guestUnavailable();
    }
    const replies = await deps.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.threadId, thread.id),
          eq(comments.workspaceId, saved.workspaceId),
          isNull(comments.deletedAt)
        )
      )
      .orderBy(asc(comments.id))
      .limit(LIVE_COMMENTS_PER_THREAD_MAX);
    return {
      comment,
      thread: {
        ...thread,
        anchor: thread.anchor
          ? commentAnchorSchema.parse(JSON.parse(thread.anchor))
          : null,
        comments: replies,
      },
    };
  };
  const validateThread = async (
    principal: Extract<Principal, { kind: "run" }>,
    input: z.infer<typeof schema>,
    threadId: string
  ) => {
    if (!(input.body || input.answered)) {
      throw guestUnavailable();
    }
    const [thread] = input.threadId
      ? await deps.db
          .select()
          .from(threads)
          .where(
            and(
              eq(threads.id, threadId),
              eq(threads.artifactId, input.artifactId),
              eq(threads.workspaceId, principal.workspaceId)
            )
          )
          .limit(1)
      : [];
    if (input.threadId && !thread) {
      throw guestUnavailable();
    }
    if (input.answered && !thread?.toAgent) {
      throw guestUnavailable();
    }
    if (input.answered && !input.body) {
      const [own] = await deps.db
        .select({ id: comments.id })
        .from(comments)
        .where(
          and(
            eq(comments.threadId, threadId),
            eq(comments.workspaceId, principal.workspaceId),
            eq(comments.runId, principal.runId),
            eq(comments.authorKind, "agent"),
            isNull(comments.deletedAt)
          )
        )
        .limit(1);
      if (!own) {
        throw guestUnavailable();
      }
    }
  };
  const commit = async (
    principal: Extract<Principal, { kind: "run" }>,
    input: z.infer<typeof schema>,
    threadId: string,
    effect: typeof guestCommentEffects.$inferSelect,
    anchor?: CommentAnchor,
    quote?: string
  ) => {
    const at = deps.clock.now().toISOString();
    await deps.atomic([
      deps.db
        .update(runRows)
        .set({
          inputText: sql`case when ${currentGuestRun(at)} and ${runRows.status}='running' and ${runRows.leaseUntil}>${at} and (select count(*) from artifact_comments where thread_id=${threadId} and workspace_id=${principal.workspaceId})<100 and (${input.threadId ? 1 : 0}=1 or (select count(*) from artifact_comment_threads where artifact_id=${input.artifactId} and workspace_id=${principal.workspaceId})<1000) then ${runRows.inputText} else null end`,
        })
        .where(
          and(
            eq(runRows.id, principal.runId),
            eq(runRows.workspaceId, principal.workspaceId),
            eq(runRows.agentId, principal.agentId),
            eq(runRows.scopeArtifactId, input.artifactId)
          )
        ),
      ...(input.threadId
        ? []
        : [
            deps.db.insert(threads).values({
              anchor: anchor ? JSON.stringify(anchor) : null,
              artifactId: input.artifactId,
              id: threadId,
              quote: anchor ? (quote ?? null) : null,
              toAgent: false,
              workspaceId: principal.workspaceId,
            }),
          ]),
      ...(effect.commentId
        ? [
            deps.db.insert(comments).values({
              authorId: principal.agentId,
              authorKind: "agent",
              body: input.body ?? "",
              createdAt: at,
              id: effect.commentId,
              runId: principal.runId,
              threadId,
              workspaceId: principal.workspaceId,
            }),
          ]
        : []),
      ...(input.answered
        ? [
            deps.db
              .update(threads)
              .set({ answeredAt: at })
              .where(
                and(
                  eq(threads.id, threadId),
                  eq(threads.artifactId, input.artifactId),
                  eq(threads.workspaceId, principal.workspaceId),
                  eq(threads.toAgent, true)
                )
              ),
          ]
        : []),
      deps.db.insert(guestCommentEffects).values(effect),
    ]);
  };
  const apply = async (
    principal: Principal,
    raw: unknown,
    callId: string,
    anchor?: CommentAnchor,
    quote?: string
  ) => {
    const input = schema.parse(raw);
    if (principal.kind !== "run" || !callId || callId.length > 200) {
      throw guestUnavailable();
    }
    await access(principal, input.artifactId);
    const fingerprint = await hashToken(JSON.stringify(input));
    const readResult = async (
      saved: typeof guestCommentEffects.$inferSelect
    ) => {
      const output = await result(saved);
      await access(principal, input.artifactId);
      return output;
    };
    const prior = await replay(principal.runId, callId, fingerprint);
    if (prior) {
      return readResult(prior);
    }
    const threadId = input.threadId ?? ulid();
    await validateThread(principal, input, threadId);
    const effect = {
      callId,
      commentId: input.body ? ulid() : null,
      fingerprint,
      id: ulid(),
      runId: principal.runId,
      threadId,
      workspaceId: principal.workspaceId,
    };
    try {
      await commit(principal, input, threadId, effect, anchor, quote);
    } catch (error) {
      await access(principal, input.artifactId);
      const saved = await replay(principal.runId, callId, fingerprint);
      if (saved) {
        return readResult(saved);
      }
      throw error;
    }
    await access(principal, input.artifactId);
    return readResult(effect);
  };
  return {
    answer: async (principal: Principal, runId: string, text: string) => {
      if (principal.kind !== "system") {
        throw guestUnavailable();
      }
      const { run } = await deps.runs.guestExecution(SYSTEM_PRINCIPAL, runId);
      const [binding] = await deps.db
        .select()
        .from(guestCommentRuns)
        .where(
          and(
            eq(guestCommentRuns.runId, run.id),
            eq(guestCommentRuns.workspaceId, run.workspaceId)
          )
        )
        .limit(1);
      if (!binding) {
        return;
      }
      const chunks = commentChunks(text);
      if (!chunks.length) {
        throw new ServiceError("invalid", "Answer must contain text");
      }
      for (const [index, body] of chunks.entries()) {
        // biome-ignore lint/performance/noAwaitInLoops: ordered durable chunks; only the last marks the thread answered.
        await apply(
          {
            agentId: run.agentId,
            kind: "run",
            runId: run.id,
            scopeArtifactId: binding.artifactId,
            workspaceId: run.workspaceId,
          },
          {
            artifactId: binding.artifactId,
            body,
            threadId: binding.threadId,
            ...(index === chunks.length - 1 ? { answered: true as const } : {}),
          },
          `answer:${run.id}:${index}`
        );
      }
    },
    apply,
  };
};

const commentChunks = (text: string) => {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of text) {
    const size = new TextEncoder().encode(character).length;
    if (bytes + size > 4096) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk.trim()) {
    chunks.push(chunk);
  }
  return chunks;
};
