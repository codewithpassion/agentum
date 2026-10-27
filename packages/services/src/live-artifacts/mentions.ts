import type { Statement } from "@repo/db/atomic";
import { artifacts } from "@repo/db/schema/artifacts";
import {
  artifactComments as comments,
  artifactMentionDeliveries as deliveries,
  artifactCommentThreads as threads,
} from "@repo/db/schema/live-artifacts";
import {
  memberMentionToken,
  mentionedMemberIds,
  readableMentions,
} from "@repo/protocol/member-mentions";
import { and, asc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import { createLiveAccess } from "./access.ts";
import type { LiveArtifactsDeps, LiveRoomScope } from "./service.ts";
import { invalid, pageSize } from "./shared.ts";

type User = Extract<Principal, { kind: "user" }>;
export interface MentionRecipient {
  email: string;
  name: string;
  principal: User;
}
export interface MentionEmail {
  artifactId: string;
  deliveryId: string;
  excerpt: string;
  threadId: string;
  title: string;
  to: string;
}
export interface LiveMentionPort {
  byEmail: (
    scope: LiveRoomScope,
    email: string
  ) => Promise<MentionRecipient | null>;
  /** Current verified address + current workspace membership. No cached identity fallback. */
  recipient: (
    scope: LiveRoomScope,
    userId: string
  ) => Promise<MentionRecipient | null>;
  send: (mail: MentionEmail) => Promise<void>;
}
export const mentionStatements = (
  deps: Pick<LiveArtifactsDeps, "db">,
  comment: {
    id: string;
    workspaceId: string;
    body: string;
    createdAt: string;
    authorId: string;
  },
  artifactId: string
): Statement[] =>
  mentionedMemberIds(comment.body)
    .filter((userId) => userId !== comment.authorId)
    .map((userId) =>
      deps.db
        .insert(deliveries)
        .values({
          artifactId,
          commentId: comment.id,
          createdAt: comment.createdAt,
          id: ulid(),
          userId,
          workspaceId: comment.workspaceId,
        })
        .onConflictDoNothing()
    );

/** At-least-once external send, bounded to five claimed attempts. A completed
 * intent is never sent again. Ambiguous provider success can duplicate email;
 * a stable deliveryId is available for provider-side dedup when supported. */
export const createLiveMentions = (
  deps: Pick<LiveArtifactsDeps, "db" | "atomic" | "clock"> & {
    mentions?: LiveMentionPort;
  }
) => {
  const { db, clock, atomic, mentions } = deps;
  const { access } = createLiveAccess(deps);
  const allowedRecipient = async (
    scope: LiveRoomScope,
    person: MentionRecipient | null
  ) => {
    if (!person || person.principal.workspaceId !== scope.workspaceId) {
      return null;
    }
    try {
      await access(person.principal, scope.artifactId, false, false, false);
      return person;
    } catch (error) {
      if (
        error instanceof ForbiddenError ||
        (error instanceof ServiceError && error.code === "not_found")
      ) {
        return null;
      }
      throw error;
    }
  };
  const processDelivery = async (
    row: typeof deliveries.$inferSelect,
    port: LiveMentionPort
  ) => {
    const now = clock.now().toISOString();
    const token = crypto.randomUUID();
    // Claim and increment in one conditional write. The exact token is checked
    // before send and on ack, so an old worker cannot ack a newer lease.
    await atomic([
      db
        .update(deliveries)
        .set({
          attempts: sql`${deliveries.attempts} + 1`,
          leaseToken: token,
          leaseUntil: new Date(clock.now().getTime() + 60_000).toISOString(),
        })
        .where(
          and(
            eq(deliveries.id, row.id),
            isNull(deliveries.completedAt),
            lt(deliveries.attempts, 5),
            or(isNull(deliveries.leaseUntil), lte(deliveries.leaseUntil, now))
          )
        ),
    ]);
    const owns = async () => {
      const [lease] = await db
        .select()
        .from(deliveries)
        .where(
          and(
            eq(deliveries.id, row.id),
            eq(deliveries.leaseToken, token),
            isNull(deliveries.completedAt),
            gt(deliveries.leaseUntil, clock.now().toISOString())
          )
        )
        .limit(1);
      return Boolean(lease);
    };
    if (!(await owns())) {
      return false;
    }
    try {
      // Tenant-join all parents: non-composite FKs alone do not prove scope.
      const [stored] = await db
        .select({ artifact: artifacts, comment: comments, thread: threads })
        .from(comments)
        .innerJoin(
          threads,
          and(
            eq(comments.threadId, threads.id),
            eq(comments.workspaceId, threads.workspaceId)
          )
        )
        .innerJoin(
          artifacts,
          and(
            eq(threads.artifactId, artifacts.id),
            eq(threads.workspaceId, artifacts.workspaceId)
          )
        )
        .where(
          and(
            eq(comments.id, row.commentId),
            eq(comments.workspaceId, row.workspaceId),
            eq(artifacts.id, row.artifactId),
            isNull(artifacts.deletedAt),
            isNull(comments.deletedAt)
          )
        )
        .limit(1);
      const scope = {
        artifactId: row.artifactId,
        workspaceId: row.workspaceId,
      };
      const person =
        stored && mentionedMemberIds(stored.comment.body).includes(row.userId)
          ? await allowedRecipient(
              scope,
              await port.recipient(scope, row.userId)
            )
          : null;
      if (
        stored &&
        person &&
        person.principal.userId === row.userId &&
        (await owns())
      ) {
        await port.send({
          artifactId: row.artifactId,
          deliveryId: row.id,
          excerpt: readableMentions(stored.comment.body).slice(0, 500),
          threadId: stored.thread.id,
          title: stored.artifact.title.slice(0, 120),
          to: person.email,
        });
      }
      if (!(await owns())) {
        return false;
      }
      // Suppress removed/revoked/deleted recipients permanently. Identity or
      // transport errors throw and remain retryable after the lease expires.
      await atomic([
        db
          .update(deliveries)
          .set({
            completedAt: clock.now().toISOString(),
            leaseToken: null,
            leaseUntil: null,
          })
          .where(
            and(
              eq(deliveries.id, row.id),
              eq(deliveries.leaseToken, token),
              isNull(deliveries.completedAt)
            )
          ),
      ]);
      return true;
    } catch {
      /* Lease expiry provides bounded retry/backoff, including ambiguous sends. */
    }

    return false;
  };
  return {
    mentionMember: async (
      principal: Principal,
      input: { artifactId: string; email: string }
    ) => {
      if (principal.kind !== "user" || !mentions) {
        throw new ForbiddenError("liveArtifacts.mentionMember");
      }
      const { row } = await access(
        principal,
        input.artifactId,
        false,
        false,
        false
      );
      const scope = { artifactId: row.id, workspaceId: row.workspaceId };
      const person = await allowedRecipient(
        scope,
        await mentions.byEmail(scope, input.email)
      );
      if (!person) {
        throw invalid("Member is not available for this artifact");
      }
      return {
        token: memberMentionToken(person.principal.userId, person.name),
      };
    },
    retryMentions: async (
      principal: Principal,
      input: { cursor?: string; limit?: number } = {}
    ) => {
      if (principal.kind !== "system") {
        throw new ForbiddenError("liveArtifacts.retryMentions");
      }
      const limit = pageSize(input.limit);
      if (!mentions) {
        return { attempted: 0, completed: 0 };
      }
      const now = clock.now().toISOString();
      const rows = await db
        .select()
        .from(deliveries)
        .where(
          and(
            isNull(deliveries.completedAt),
            lt(deliveries.attempts, 5),
            or(isNull(deliveries.leaseUntil), lte(deliveries.leaseUntil, now)),
            input.cursor ? gt(deliveries.id, input.cursor) : undefined
          )
        )
        .orderBy(asc(deliveries.id))
        .limit(limit + 1);
      let completed = 0;
      for (const row of rows.slice(0, limit)) {
        // biome-ignore lint/performance/noAwaitInLoops: each intent has a separate conditional lease
        if (await processDelivery(row, mentions)) {
          completed += 1;
        }
      }
      return {
        attempted: Math.min(limit, rows.length),
        completed,
        ...(rows.length > limit ? { next: rows[limit - 1]?.id } : {}),
      };
    },
  };
};
