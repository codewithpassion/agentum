// A dream the `ask_first` learn level held, or one that rests on outside
// evidence, writes `memory_changes` rows with status `held`. The batch waits
// for its agent's owner or an org admin, who approve or reject all of it.
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { dreamQuestions, dreamRuns } from "@repo/db/schema/dreams";
import { memoryChanges } from "@repo/db/schema/memory";
import { and, count, eq, exists, inArray, isNull, or } from "drizzle-orm";
import type { Principal } from "../workspaces.ts";

type UserPrincipal = Extract<Principal, { kind: "user" }>;

/** One dream that waits for a decision. */
export interface HeldBatch {
  agentId: string;
  at: string;
  diary: string;
  dreamRunId: string;
}

const stillHeld = and(
  eq(memoryChanges.status, "held"),
  isNull(memoryChanges.decidedAt)
);

/** How many changes each of these dreams still holds. A dream with none is absent. */
export const heldCounts = async (
  db: Database,
  dreamRunIds: readonly string[]
): Promise<Map<string, number>> => {
  if (dreamRunIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ held: count(), id: memoryChanges.dreamRunId })
    .from(memoryChanges)
    .where(and(inArray(memoryChanges.dreamRunId, [...dreamRunIds]), stillHeld))
    .groupBy(memoryChanges.dreamRunId);
  return new Map(
    rows.flatMap((row) => (row.id === null ? [] : [[row.id, row.held]]))
  );
};

/** How many questions each of these dreams still has open. A dream with none is absent. */
export const openQuestionCounts = async (
  db: Database,
  dreamRunIds: readonly string[]
): Promise<Map<string, number>> => {
  if (dreamRunIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: dreamQuestions.dreamRunId, open: count() })
    .from(dreamQuestions)
    .where(
      and(
        inArray(dreamQuestions.dreamRunId, [...dreamRunIds]),
        eq(dreamQuestions.status, "open")
      )
    )
    .groupBy(dreamQuestions.dreamRunId);
  return new Map(rows.map((row) => [row.id, row.open]));
};

/** The held dreams this person may decide: the owner's agents, or every agent for an org admin. */
export const heldBatchesFor = async (
  db: Database,
  member: UserPrincipal
): Promise<HeldBatch[]> => {
  const rows = await db
    .select({
      agentId: agents.id,
      at: dreamRuns.startedAt,
      diary: dreamRuns.diary,
      dreamRunId: dreamRuns.id,
    })
    .from(dreamRuns)
    .innerJoin(agents, eq(agents.id, dreamRuns.agentId))
    .where(
      and(
        eq(dreamRuns.workspaceId, member.workspaceId),
        eq(dreamRuns.status, "done"),
        eq(agents.status, "active"),
        exists(
          db
            .select({ one: memoryChanges.id })
            .from(memoryChanges)
            .where(and(eq(memoryChanges.dreamRunId, dreamRuns.id), stillHeld))
        ),
        // Only the owner (else the creator) or an org admin can decide, so only they get the card.
        member.isAdmin === true
          ? undefined
          : or(
              eq(agents.ownerUserId, member.userId),
              and(
                isNull(agents.ownerUserId),
                eq(agents.createdBy, member.userId)
              )
            )
      )
    );
  return rows;
};
