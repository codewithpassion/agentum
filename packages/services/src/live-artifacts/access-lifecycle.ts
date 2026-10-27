import { artifacts } from "@repo/db/schema/artifacts";
import { artifactRoomInvalidations as invalidations } from "@repo/db/schema/live-artifacts";
import type { ArtifactAudience } from "@repo/db/shared";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { ulid } from "ulidx";
import { ForbiddenError } from "../authz.ts";
import type { Principal } from "../workspaces.ts";
import { type InteractionContext, missing, pageSize } from "./shared.ts";

/** Membership mutations in L.7 must include this statement in their atomic
 * grant update. The scheduled adapter drains it even if the request crashes. */
export const roomInvalidationStatement = (
  deps: Pick<InteractionContext, "db" | "clock">,
  scope: { workspaceId: string; artifactId: string },
  participantId?: string
) =>
  deps.db.insert(invalidations).values({
    ...scope,
    completedAt: null,
    createdAt: deps.clock.now().toISOString(),
    id: ulid(),
    participantId: participantId ?? null,
  });

export const createAccessLifecycle = (ctx: InteractionContext) => {
  const queue = (
    workspaceId: string,
    artifactId: string,
    participantId?: string
  ) => ({
    artifactId,
    completedAt: null,
    createdAt: ctx.now(),
    id: ulid(),
    participantId: participantId ?? null,
    workspaceId,
  });
  const deliver = async (entry: typeof invalidations.$inferSelect) => {
    // Do not use findArtifact: a deleted artifact still has a room to close.
    const [row] = await ctx.db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, entry.artifactId),
          eq(artifacts.workspaceId, entry.workspaceId)
        )
      )
      .limit(1);
    if (!row) {
      throw missing();
    }
    await ctx.rooms.refresh(
      { artifactId: entry.artifactId, workspaceId: entry.workspaceId },
      entry.participantId ?? undefined,
      entry.id
    );
    await ctx.atomic([
      ctx.db
        .update(invalidations)
        .set({ completedAt: ctx.now() })
        .where(
          and(
            eq(invalidations.id, entry.id),
            eq(invalidations.workspaceId, entry.workspaceId),
            isNull(invalidations.completedAt)
          )
        ),
    ]);
  };
  return {
    async invalidateAccess(
      principal: Principal,
      input: { artifactId: string; participantId?: string }
    ) {
      const { row } = await ctx.access(principal, input.artifactId, true, true);
      const entry = queue(row.workspaceId, row.id, input.participantId);
      await ctx.rooms.suspend?.(
        { artifactId: row.id, workspaceId: row.workspaceId },
        entry.id
      );
      await ctx.atomic([ctx.db.insert(invalidations).values(entry)]);
      await deliver(entry);
    },
    async remove(principal: Principal, input: { artifactId: string }) {
      const { member, row } = await ctx.access(
        principal,
        input.artifactId,
        true,
        true
      );
      if (member.kind !== "user") {
        throw new ForbiddenError("liveArtifacts.remove");
      }
      const entry = queue(row.workspaceId, row.id);
      await ctx.rooms.suspend?.(
        { artifactId: row.id, workspaceId: row.workspaceId },
        entry.id
      );
      await ctx.atomic([
        ctx.db
          .update(artifacts)
          .set({
            deletedAt: ctx.now(),
            deletedBy: member.userId,
            updatedAt: ctx.now(),
          })
          .where(
            and(
              eq(artifacts.id, row.id),
              eq(artifacts.workspaceId, row.workspaceId)
            )
          ),
        ctx.db.insert(invalidations).values(entry),
        ctx.event(member, row, "artifact.deleted", {
          artifactId: row.id,
          title: row.title,
        }),
      ]);
      await deliver(entry);
    },
    /** Trusted scheduled/queue adapter only. Never expose through a user router.
     * Failed deliveries remain pending; refresh must be idempotent. */
    async retryInvalidations(
      principal: Principal,
      input: { limit?: number; cursor?: string } = {}
    ) {
      if (principal.kind !== "system") {
        throw new ForbiddenError("liveArtifacts.retryInvalidations");
      }
      const limit = pageSize(input.limit);
      const rows = await ctx.db
        .select()
        .from(invalidations)
        .where(
          and(
            isNull(invalidations.completedAt),
            input.cursor ? gt(invalidations.id, input.cursor) : undefined
          )
        )
        .orderBy(asc(invalidations.id))
        .limit(limit + 1);
      let completed = 0;
      for (const row of rows.slice(0, limit)) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: serialize room refresh and durable acknowledgement
          await deliver(row);
          completed += 1;
        } catch {
          /* Durable row remains pending for the next delivery. */
        }
      }
      return {
        attempted: Math.min(rows.length, limit),
        completed,
        ...(rows.length > limit ? { next: rows[limit - 1]?.id } : {}),
      };
    },
    async setAudience(
      principal: Principal,
      input: { artifactId: string; audience: ArtifactAudience }
    ) {
      const { member, row } = await ctx.access(
        principal,
        input.artifactId,
        true,
        true
      );
      if (member.kind !== "user") {
        throw new ForbiddenError("liveArtifacts.setAudience");
      }
      const entry = queue(row.workspaceId, row.id);
      await ctx.rooms.suspend?.(
        { artifactId: row.id, workspaceId: row.workspaceId },
        entry.id
      );
      await ctx.atomic([
        ctx.db
          .update(artifacts)
          .set({ audience: input.audience, updatedAt: ctx.now() })
          .where(
            and(
              eq(artifacts.id, row.id),
              eq(artifacts.workspaceId, row.workspaceId)
            )
          ),
        ctx.db.insert(invalidations).values(entry),
        ctx.event(member, row, "artifact.audience_changed", {
          artifactId: row.id,
          from: row.audience,
          to: input.audience,
        }),
      ]);
      await deliver(entry);
    },
  };
};
