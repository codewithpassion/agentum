import { artifactLiveChanges as changes } from "@repo/db/schema/live-artifacts";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import {
  type InteractionContext,
  invalid,
  missing,
  pageSize,
} from "./shared.ts";

export const createChangesModule = (ctx: InteractionContext) => ({
  async changes(
    principal: Principal,
    input: { artifactId: string; cursor?: string; limit?: number }
  ) {
    const { row } = await ctx.access(
      principal,
      input.artifactId,
      false,
      false,
      false
    );
    const limit = pageSize(input.limit);
    const rows = await ctx.db
      .select()
      .from(changes)
      .where(
        and(
          eq(changes.workspaceId, row.workspaceId),
          eq(changes.artifactId, row.id),
          input.cursor ? lt(changes.id, input.cursor) : undefined
        )
      )
      .orderBy(desc(changes.id))
      .limit(limit + 1);
    return {
      items: rows.slice(0, limit),
      ...(rows.length > limit ? { next: rows[limit - 1]?.id } : {}),
    };
  },
  /** Called after the room has committed an agent operation with guarded anchors. */
  async recordChange(
    principal: Principal,
    input: {
      artifactId: string;
      toolCallId: string;
      summary: string;
      revFrom: number;
      revTo: number;
    }
  ) {
    const { member, row } = await ctx.access(
      principal,
      input.artifactId,
      true,
      false,
      false
    );
    if (member.kind !== "run") {
      throw new ForbiddenError("liveArtifacts.recordChange");
    }
    if (
      !input.toolCallId.trim() ||
      input.toolCallId.length > 200 ||
      !input.summary.trim() ||
      new TextEncoder().encode(input.summary).length > 4096 ||
      !Number.isSafeInteger(input.revFrom) ||
      !Number.isSafeInteger(input.revTo) ||
      input.revFrom < 0 ||
      input.revTo <= input.revFrom
    ) {
      throw invalid("Invalid agent change");
    }
    const change = {
      ...input,
      createdAt: ctx.now(),
      id: ulid(),
      revertedAt: null,
      revertedBy: null,
      runId: member.runId,
      workspaceId: row.workspaceId,
    };
    await ctx.atomic([ctx.db.insert(changes).values(change)]);
    return change;
  },
  async revertChange(principal: Principal, input: { changeId: string }) {
    if (principal.kind === "system") {
      throw new ForbiddenError("liveArtifacts.revert");
    }
    const [change] = await ctx.db
      .select()
      .from(changes)
      .where(
        and(
          eq(changes.id, input.changeId),
          eq(changes.workspaceId, principal.workspaceId)
        )
      )
      .limit(1);
    if (!change) {
      throw missing();
    }
    const { member, row } = await ctx.access(
      principal,
      change.artifactId,
      true,
      false,
      false
    );
    if (member.kind !== "user") {
      throw new ForbiddenError("liveArtifacts.revert");
    }
    // Validate the persisted run's full workspace/agent/session chain as well.
    const { runs } = await import("@repo/db/schema/runs");
    const [run] = await ctx.db
      .select()
      .from(runs)
      .where(
        and(eq(runs.id, change.runId), eq(runs.workspaceId, row.workspaceId))
      )
      .limit(1);
    if (!run) {
      throw missing();
    }
    const { agents } = await import("@repo/db/schema/agents");
    const { sessions } = await import("@repo/db/schema/sessions");
    const [agent] = await ctx.db
      .select()
      .from(agents)
      .where(
        and(eq(agents.id, run.agentId), eq(agents.workspaceId, row.workspaceId))
      )
      .limit(1);
    const [session] = await ctx.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.id, run.sessionId),
          eq(sessions.workspaceId, row.workspaceId),
          eq(sessions.agentId, run.agentId)
        )
      )
      .limit(1);
    if (!(agent && session)) {
      throw missing();
    }
    if (change.revertedAt) {
      return;
    }
    const result = await ctx.changes.revert(
      { artifactId: row.id, workspaceId: row.workspaceId },
      {
        byParticipant: ctx.participantId(member),
        changeId: change.id,
        revFrom: change.revFrom,
        revTo: change.revTo,
        runId: change.runId,
        toolCallId: change.toolCallId,
      }
    );
    if (
      !Number.isSafeInteger(result.revision) ||
      result.revision <= change.revTo ||
      typeof result.byParticipant !== "string" ||
      !result.byParticipant.startsWith("u:") ||
      result.byParticipant.length <= 2
    ) {
      throw new ServiceError(
        "conflict",
        "Room did not confirm a new revert revision"
      );
    }
    await ctx.atomic([
      ctx.db
        .update(changes)
        .set({ revertedAt: ctx.now(), revertedBy: result.byParticipant })
        .where(
          and(
            eq(changes.id, change.id),
            eq(changes.workspaceId, row.workspaceId),
            isNull(changes.revertedAt)
          )
        ),
      ctx.event(
        { ...member, userId: result.byParticipant.slice(2) },
        row,
        "artifact.agent_change_reverted",
        {
          artifactId: row.id,
          changeId: change.id,
          revision: result.revision,
          runId: change.runId,
        },
        sql`changes() = 1`
      ),
    ]);
  },
});
