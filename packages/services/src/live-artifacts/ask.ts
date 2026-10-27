import type { Atomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import {
  artifactAskDispatches,
  artifactComments,
  artifactCommentThreads,
} from "@repo/db/schema/live-artifacts";
import { sessions } from "@repo/db/schema/sessions";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "../authz.ts";
import { loadRunByRequest } from "../runs/queries.ts";
import type { RunsService } from "../runs.ts";
import { buildSpeakerEnvelope, type SpeakerRoom } from "../speaker-envelope.ts";
import type { Principal } from "../workspaces.ts";
import { createLiveAccess } from "./access.ts";
import type { LiveAskPort } from "./ports.ts";
import type { LiveArtifactsDeps, LiveRoomScope } from "./service.ts";
import { canComment, invalid, missing, pageSize } from "./shared.ts";

const id = z.string().min(1).max(200);
export const liveAskInputSchema = z.strictObject({
  agentId: id.optional(),
  artifactId: z.uuid(),
  text: z.string().trim().min(1).max(16_000),
  via: z.enum(["artifact_thread", "ask_agent"]),
});
export type LiveAskInput = z.infer<typeof liveAskInputSchema>;
export interface LiveAskDeps
  extends Pick<LiveArtifactsDeps, "db" | "clock" | "identity"> {
  atomic: Atomic;
  /** Must read this authenticated sender's current, authorized room awareness.
   * Resolve names/roster through current admission, never raw client awareness. */
  presence: (
    scope: LiveRoomScope,
    member: Extract<Principal, { kind: "user" }>
  ) => Promise<Pick<SpeakerRoom, "where" | "present">>;
  /** Resolve current workspace membership and credential restrictions; null if no longer a member. */
  resolveMember: (
    scope: LiveRoomScope,
    userId: string
  ) => Promise<Extract<Principal, { kind: "user" }> | null>;
  runs: Pick<RunsService, "startRun">;
}

const previousResult = (
  previous: NonNullable<Awaited<ReturnType<typeof loadRunByRequest>>>,
  userId: string,
  sessionId?: string
) => {
  if (
    previous.actor.kind !== "user" ||
    previous.actor.id !== userId ||
    previous.sessionId !== sessionId
  ) {
    throw new ForbiddenError("liveArtifacts.askRetry");
  }
  return {
    runId: previous.id,
    sessionId: previous.sessionId,
    status: previous.status,
  };
};
const matchesMember = (
  member: Extract<Principal, { kind: "user" }> | null,
  dispatch: { authorId: string; workspaceId: string }
): member is Extract<Principal, { kind: "user" }> =>
  member?.userId === dispatch.authorId &&
  member?.workspaceId === dispatch.workspaceId;

/** Construct before core/comments: this service has no dependency on that factory. */
export const createLiveAskService = (deps: LiveAskDeps) => {
  const { db } = deps;
  const { access } = createLiveAccess(deps);
  const context = async (principal: Principal, artifactId: string) => {
    if (principal.kind !== "user") {
      throw new ForbiddenError("liveArtifacts.ask");
    }
    const { row, role } = await access(
      principal,
      artifactId,
      false,
      false,
      false
    );
    if (row.kind !== "document" && row.kind !== "deck") {
      throw missing();
    }
    canComment(role);
    return { member: principal, role, row };
  };
  const session = async (
    principal: Principal,
    input: { artifactId: string }
  ) => {
    // Reading the thread is available even to viewers.
    const { row } = await access(
      principal,
      input.artifactId,
      false,
      false,
      false
    );
    if (row.kind !== "document" && row.kind !== "deck") {
      throw missing();
    }
    const [found] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, row.workspaceId),
          eq(sessions.origin, "artifact"),
          eq(sessions.externalKey, row.id)
        )
      )
      .limit(1);
    return found
      ? {
          agentId: found.agentId,
          createdAt: found.createdAt,
          externalKey: found.externalKey,
          id: found.id,
          lastRunAt: found.lastRunAt,
          origin: found.origin,
          private: found.private,
        }
      : null;
  };
  const start = async (
    principal: Principal,
    input: {
      artifactId: string;
      text: string;
      agentId?: string;
      via: "artifact_thread" | "ask_agent" | "comment";
      threadId?: string;
      requestId?: string;
    }
  ) => {
    const { member, row } = await context(principal, input.artifactId);
    if (!input.text.trim() || input.text.length > 16_000) {
      throw invalid("Ask text must be 1 to 16000 characters");
    }
    const known = await session(member, { artifactId: row.id });
    const previous = input.requestId
      ? await loadRunByRequest(db, row.workspaceId, input.requestId)
      : null;
    if (previous) {
      return previousResult(previous, member.userId, known?.id);
    }
    const agentId =
      input.agentId ?? known?.agentId ?? row.handedToAgentId ?? row.agentId;
    if (!agentId) {
      throw invalid("Select an agent before asking");
    }
    const [agent] = await db
      .select()
      .from(agents)
      .where(
        and(eq(agents.id, agentId), eq(agents.workspaceId, member.workspaceId))
      )
      .limit(1);
    if (agent?.status !== "active") {
      throw missing();
    }
    authorize(member, "runs.start", {
      kind: "run",
      workspaceId: agent.workspaceId,
    });
    const scope = { artifactId: row.id, workspaceId: row.workspaceId };
    const room = await deps.presence(scope, member);
    if (
      input.via === "ask_agent" &&
      !room.where?.selection &&
      !room.where?.slideId
    ) {
      throw invalid("No current selection");
    }
    const identity = await deps.identity(member);
    const current = await context(member, row.id);
    const text = buildSpeakerEnvelope(
      {
        actor: { id: member.userId, kind: "user" },
        name: identity.name,
        role: current.role,
      },
      {
        ...room,
        artifact: {
          id: row.id,
          kind: row.kind as "document" | "deck",
          title: row.title,
        },
        where: input.threadId
          ? { ...room.where, threadId: input.threadId }
          : room.where,
      },
      input.via,
      input.text
    );
    return deps.runs.startRun(
      member,
      {
        agentId,
        input: { text },
        requestId: input.requestId,
        session: { externalKey: row.id, origin: "artifact" },
      },
      known ? { sessionId: known.id } : {}
    );
  };
  const startComment: LiveAskPort["startComment"] = async (
    principal,
    input
  ) => {
    const { member, row } = await context(principal, input.artifactId);
    if (input.workspaceId !== row.workspaceId) {
      throw missing();
    }
    const [stored] = await db
      .select({ comment: artifactComments, thread: artifactCommentThreads })
      .from(artifactComments)
      .innerJoin(
        artifactCommentThreads,
        eq(artifactCommentThreads.id, artifactComments.threadId)
      )
      .where(
        and(
          eq(artifactComments.id, input.commentId),
          eq(artifactComments.workspaceId, row.workspaceId),
          eq(artifactCommentThreads.workspaceId, row.workspaceId),
          eq(artifactCommentThreads.artifactId, row.id),
          eq(artifactCommentThreads.id, input.threadId),
          isNull(artifactComments.deletedAt)
        )
      )
      .limit(1);
    if (
      !stored?.thread.toAgent ||
      stored.comment.authorKind !== "user" ||
      stored.comment.authorId !== member.userId
    ) {
      throw missing();
    }
    const [dispatch] = await db
      .select()
      .from(artifactAskDispatches)
      .where(
        and(
          eq(artifactAskDispatches.commentId, stored.comment.id),
          eq(artifactAskDispatches.workspaceId, row.workspaceId),
          eq(artifactAskDispatches.artifactId, row.id),
          eq(artifactAskDispatches.authorId, member.userId)
        )
      )
      .limit(1);
    if (!dispatch) {
      throw missing();
    }
    const result = await start(member, {
      artifactId: row.id,
      requestId: `live-comment:${stored.comment.id}`,
      text: stored.comment.body,
      threadId: stored.thread.id,
      via: "comment",
    });
    await deps.atomic([
      db
        .update(artifactAskDispatches)
        .set({
          completedAt: deps.clock.now().toISOString(),
          runId: result.runId,
        })
        .where(
          and(
            eq(artifactAskDispatches.id, dispatch.id),
            eq(artifactAskDispatches.workspaceId, row.workspaceId),
            isNull(artifactAskDispatches.completedAt)
          )
        ),
    ]);
    return result;
  };
  return {
    ask: async (principal: Principal, input: LiveAskInput) =>
      start(principal, liveAskInputSchema.parse(input)),
    retryCommentAsk: async (
      principal: Principal,
      input: { artifactId: string; threadId: string; commentId: string }
    ) => {
      if (principal.kind !== "user") {
        throw new ForbiddenError("liveArtifacts.ask");
      }
      return await startComment(principal, {
        ...input,
        text: "",
        workspaceId: principal.workspaceId,
      });
    },
    async retryDispatches(
      principal: Principal,
      input: { limit?: number; cursor?: string } = {}
    ) {
      if (principal.kind !== "system") {
        throw new ForbiddenError("liveArtifacts.retryDispatches");
      }
      const limit = pageSize(input.limit);
      const rows = await db
        .select()
        .from(artifactAskDispatches)
        .where(
          and(
            isNull(artifactAskDispatches.completedAt),
            input.cursor
              ? gt(artifactAskDispatches.id, input.cursor)
              : undefined
          )
        )
        .orderBy(asc(artifactAskDispatches.id))
        .limit(limit + 1);
      let completed = 0;
      for (const dispatch of rows.slice(0, limit)) {
        try {
          const scope = {
            artifactId: dispatch.artifactId,
            workspaceId: dispatch.workspaceId,
          };
          // biome-ignore lint/performance/noAwaitInLoops: independently retry durable deliveries
          const member = await deps.resolveMember(scope, dispatch.authorId);
          if (!matchesMember(member, dispatch)) {
            continue;
          }
          const [comment] = await db
            .select()
            .from(artifactComments)
            .where(
              and(
                eq(artifactComments.id, dispatch.commentId),
                eq(artifactComments.workspaceId, dispatch.workspaceId)
              )
            )
            .limit(1);
          if (!comment) {
            continue;
          }
          await startComment(member, {
            ...scope,
            commentId: comment.id,
            text: comment.body,
            threadId: comment.threadId,
          });
          completed += 1;
        } catch {
          /* Leave pending for a later processing sweep. */
        }
      }
      return {
        attempted: Math.min(limit, rows.length),
        completed,
        ...(rows.length > limit ? { next: rows[limit - 1]?.id } : {}),
      };
    },
    async selectAgent(
      principal: Principal,
      input: { artifactId: string; agentId: string }
    ) {
      const { member, row } = await context(principal, input.artifactId);
      const [agent] = await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.id, input.agentId),
            eq(agents.workspaceId, row.workspaceId)
          )
        )
        .limit(1);
      if (agent?.status !== "active") {
        throw missing();
      }
      authorize(member, "runs.start", {
        kind: "run",
        workspaceId: agent.workspaceId,
      });
      // Uniqueness is artifact-wide, independent of the selected agent.
      await deps.atomic([
        db
          .insert(sessions)
          .values({
            actorId: member.userId,
            actorKind: "user",
            agentId: agent.id,
            createdAt: deps.clock.now().toISOString(),
            externalKey: row.id,
            id: ulid(),
            origin: "artifact",
            workspaceId: row.workspaceId,
          })
          .onConflictDoNothing(),
        db
          .update(sessions)
          .set({ agentId: agent.id, runtimeMachineId: null, runtimeRef: null })
          .where(
            and(
              eq(sessions.workspaceId, row.workspaceId),
              eq(sessions.origin, "artifact"),
              eq(sessions.externalKey, row.id)
            )
          ),
      ]);
      return session(member, { artifactId: row.id });
    },
    session,
    startComment,
  };
};
export type LiveAskService = ReturnType<typeof createLiveAskService>;
