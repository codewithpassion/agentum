/**
 * Routines: a `triggers` row of kind `routine` that starts one agent on a cron
 * schedule. A person makes, pauses and removes them. An agent's run may only
 * propose one for its own agent: it is stored paused and marked as proposed,
 * and fires once a person approves it (`approve`) or deletes it (`reject`).
 * The minute tick calls `fireDue` and `settleRuns`.
 *
 * `fireDue` takes each row whose `next_run_at` has passed and does one atomic
 * write: the run, keyed `trigger:<id>:<slot>`, and the move of `next_run_at`
 * to the next slot, guarded by the slot it was read at. Two overlapping ticks
 * give the same key, so the second insert fails and the first run is read
 * back. A write that fails leaves `next_run_at` where it was, so the next tick
 * fires the slot. A run left `queued` by a crash after the write is offered
 * again by the queued-run sweep. Slots missed while the tick was down collapse
 * into one run, and the next slot is the first one after now.
 *
 * `consecutive_errors` counts slots that could not be written and runs that
 * ended `failed` or `interrupted`. The fifth in a row switches the routine
 * off (`disabled_at`); a `done` run resets the count. `settleRuns` reads the
 * routine's runs (`runs.actor_id` is the routine id) in order from
 * `settled_run_id` on, so every run is counted once, however long it takes.
 */
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { runs } from "@repo/db/schema/runs";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import { isPendingProposal, ROUTINE_ERROR_LIMIT } from "@repo/db/shared";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  min,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { ulid } from "ulidx";
import { z } from "zod";
import { findAgent } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import {
  createdByOf,
  proposalColumns,
  recordChange,
  requireApprover,
  requireOwnAgent,
  requireReader,
  requireWriter,
} from "./automation-access.ts";
import { ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import {
  isValidTimeZone,
  nextFireTime,
  validateCron,
} from "./routines/cron.ts";
import { type Clock, INPUT_TEXT_MAX } from "./runs/types.ts";
import type { RunsService } from "./runs.ts";
import type { Principal } from "./workspaces.ts";

/** Routines one tick fires or settles; the next minute takes the rest. */
const TICK_BATCH = 100;
/** Runs of one routine that one `settleRuns` call counts. */
const SETTLE_RUNS_PER_ROUTINE = 100;
const ERROR_MESSAGE_MAX = 500;

const ROUTINE_KIND = "routine";
const CREATE_ACTION = "routines.create";
const LIST_ACTION = "routines.list";
const ENABLE_ACTION = "routines.setEnabled";
const REMOVE_ACTION = "routines.remove";
const APPROVE_ACTION = "routines.approve";
const REJECT_ACTION = "routines.reject";
const FIRE_ACTION = "routines.fire";
const SETTLE_ACTION = "routines.settle";

export const routineCreateInputSchema = z.strictObject({
  agentId: z.string().min(1).max(200),
  cron: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(INPUT_TEXT_MAX),
  /** An IANA zone. The workspace's timezone when left out. */
  timezone: z.string().trim().min(1).max(64).optional(),
});
export type RoutineCreateInput = z.input<typeof routineCreateInputSchema>;

export const routineListInputSchema = z.strictObject({
  agentId: z.string().min(1).max(200).optional(),
});
export type RoutineListInput = z.input<typeof routineListInputSchema>;

export const routineSetEnabledInputSchema = z.strictObject({
  enabled: z.boolean(),
  routineId: z.string().min(1).max(200),
});
export type RoutineSetEnabledInput = z.input<
  typeof routineSetEnabledInputSchema
>;

/** A routine as a signed-in user sees it. */
export interface RoutineSummary {
  agentId: string;
  agentName: string;
  /** When a person approved a proposal. Null for one still waiting, and for one a person made. */
  approvedAt: string | null;
  consecutiveErrors: number;
  createdAt: string;
  cron: string;
  disabledAt: string | null;
  id: string;
  lastError: string | null;
  lastFiredAt: string | null;
  name: string;
  /** The slot the tick fires next. Pausing keeps it; resuming picks a new one. */
  nextRunAt: string | null;
  prompt: string;
  /** Set when an agent's run proposed the routine. */
  proposedByAgentId: string | null;
  proposedByRunId: string | null;
  timezone: string;
}

/** What one `fireDue` call did. Run ids, and the routines that failed. */
export interface FireDueResult {
  failed: { message: string; routineId: string }[];
  fired: string[];
  /** Slots whose run another tick had already written. */
  readBack: string[];
}

/** What one `settleRuns` call did: how many routines it updated. */
export interface SettleResult {
  settled: number;
}

const summaryColumns = {
  agentId: triggers.agentId,
  agentName: agents.name,
  approvedAt: triggers.approvedAt,
  consecutiveErrors: triggers.consecutiveErrors,
  createdAt: triggers.createdAt,
  cron: sql<string>`coalesce(${triggers.cron}, '')`,
  disabledAt: triggers.disabledAt,
  id: triggers.id,
  lastError: triggers.lastError,
  lastFiredAt: triggers.lastFiredAt,
  name: triggers.name,
  nextRunAt: triggers.nextRunAt,
  prompt: sql<string>`coalesce(${triggers.prompt}, '')`,
  proposedByAgentId: triggers.proposedByAgentId,
  proposedByRunId: triggers.proposedByRunId,
  timezone: sql<string>`coalesce(${triggers.timezone}, '')`,
};

const requireSystem = (principal: Principal, action: string): void => {
  if (principal.kind !== "system") {
    throw new ForbiddenError(action);
  }
};

const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(
    0,
    ERROR_MESSAGE_MAX
  );

/** The next slot after `after` as an ISO instant, or null if there is none. */
const nextSlot = (cron: string, timezone: string, after: Date) => {
  const next = nextFireTime(cron, timezone, after);
  return next === null ? null : new Date(next).toISOString();
};

const ENDED = ["done", "failed", "interrupted", "cancelled"] as const;

/**
 * Folds the ended runs at the front of `runList` into an error count. Null
 * when the first run has not ended, so there is nothing to judge yet.
 */
const judge = (
  runList: readonly {
    runError: string | null;
    runId: string;
    status: string;
  }[],
  before: { errors: number; lastError: string | null }
): {
  errors: number;
  lastError: string | null;
  settledRunId: string;
} | null => {
  let { errors, lastError } = before;
  let settledRunId: string | null = null;
  for (const run of runList) {
    if (!(ENDED as readonly string[]).includes(run.status)) {
      break;
    }
    settledRunId = run.runId;
    if (run.status === "done") {
      errors = 0;
      lastError = null;
    } else if (run.status !== "cancelled") {
      errors += 1;
      lastError = (run.runError ?? `Run ${run.status}`).slice(
        0,
        ERROR_MESSAGE_MAX
      );
    }
  }
  return settledRunId === null ? null : { errors, lastError, settledRunId };
};

export const createRoutinesService = ({
  allowedOrgIds,
  clock,
  db,
  events,
  runs: runsService,
}: {
  /** Routines of a workspace outside this list stop firing, like its triggers. */
  allowedOrgIds: readonly string[];
  clock: Clock;
  db: Database;
  events: EventsService;
  runs: RunsService;
}) => {
  const findSummary = async (
    routineId: string,
    workspaceId: string
  ): Promise<RoutineSummary | null> => {
    const [row] = await db
      .select(summaryColumns)
      .from(triggers)
      .innerJoin(agents, eq(agents.id, triggers.agentId))
      .where(
        and(
          eq(triggers.id, routineId),
          eq(triggers.workspaceId, workspaceId),
          eq(triggers.kind, ROUTINE_KIND),
          isNull(triggers.revokedAt)
        )
      )
      .limit(1);
    return row ?? null;
  };

  const requireSummary = async (routineId: string, workspaceId: string) => {
    const summary = await findSummary(routineId, workspaceId);
    if (!summary) {
      throw new ServiceError("not_found", "Routine not found");
    }
    return summary;
  };

  const workspaceTimezone = async (workspaceId: string): Promise<string> => {
    const [workspace] = await db
      .select({ timezone: workspaces.timezone })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!workspace) {
      throw new ServiceError("not_found", "Workspace not found");
    }
    return workspace.timezone;
  };

  /**
   * A routine for one agent, first due at the next slot after now. From a
   * run it is a proposal: stored paused, for the run's own agent only, and
   * it fires once a person approves it.
   */
  const create = async (
    principal: Principal,
    input: RoutineCreateInput
  ): Promise<RoutineSummary> => {
    const actor = requireWriter(principal, CREATE_ACTION);
    const parsed = routineCreateInputSchema.parse(input);
    authorize(actor, CREATE_ACTION, {
      kind: ROUTINE_KIND,
      workspaceId: actor.workspaceId,
    });
    requireOwnAgent(actor, parsed.agentId, CREATE_ACTION);
    const cronError = validateCron(parsed.cron);
    if (cronError !== null) {
      throw new ServiceError("invalid", cronError);
    }
    const timezone =
      parsed.timezone ?? (await workspaceTimezone(actor.workspaceId));
    if (!isValidTimeZone(timezone)) {
      throw new ServiceError("invalid", `Unknown timezone ${timezone}`);
    }
    const agent = await findAgent(db, {
      id: parsed.agentId,
      workspaceId: actor.workspaceId,
    });
    if (agent?.status !== "active") {
      throw new ServiceError("not_found", "Agent not found");
    }
    const now = clock.now();
    const nextRunAt = nextSlot(parsed.cron, timezone, now);
    if (nextRunAt === null) {
      throw new ServiceError("invalid", "That schedule never fires");
    }
    const proposed = actor.kind === "run";
    const id = `rtn_${ulid(now.getTime())}`;
    await db.insert(triggers).values({
      agentId: agent.id,
      createdAt: now.toISOString(),
      createdBy: createdByOf(actor),
      cron: parsed.cron,
      // A proposal is paused with no slot; approving it picks the next one.
      disabledAt: proposed ? now.toISOString() : null,
      id,
      kind: ROUTINE_KIND,
      name: parsed.name,
      nextRunAt: proposed ? null : nextRunAt,
      prompt: parsed.prompt,
      timezone,
      workspaceId: actor.workspaceId,
      ...proposalColumns(actor),
    });
    await recordChange(events, actor, {
      agentId: agent.id,
      change: "created",
      kind: ROUTINE_KIND,
      name: parsed.name,
      proposed,
      triggerId: id,
      workspaceId: actor.workspaceId,
    });
    return await requireSummary(id, actor.workspaceId);
  };

  /** The workspace's routines, newest first. Removed ones are left out. A run sees its own agent's. */
  const list = async (
    principal: Principal,
    input: RoutineListInput = {}
  ): Promise<RoutineSummary[]> => {
    const reader = requireReader(principal, LIST_ACTION);
    const { agentId } = routineListInputSchema.parse(input);
    authorize(reader, LIST_ACTION, {
      kind: ROUTINE_KIND,
      workspaceId: reader.workspaceId,
    });
    if (agentId !== undefined) {
      requireOwnAgent(reader, agentId, LIST_ACTION);
    }
    const onlyAgent = reader.kind === "run" ? reader.agentId : agentId;
    return await db
      .select(summaryColumns)
      .from(triggers)
      .innerJoin(agents, eq(agents.id, triggers.agentId))
      .where(
        and(
          eq(triggers.workspaceId, reader.workspaceId),
          eq(triggers.kind, ROUTINE_KIND),
          isNull(triggers.revokedAt),
          onlyAgent === undefined ? undefined : eq(triggers.agentId, onlyAgent)
        )
      )
      .orderBy(desc(triggers.createdAt), desc(triggers.id));
  };

  /**
   * Approves a proposal: it fires from the next slot after now. Approving
   * needs the rights that creating a routine needs, and a run has none.
   */
  const approve = async (
    principal: Principal,
    routineId: string
  ): Promise<RoutineSummary> => {
    const user = requireApprover(principal, APPROVE_ACTION);
    authorize(user, CREATE_ACTION, {
      id: routineId,
      kind: ROUTINE_KIND,
      workspaceId: user.workspaceId,
    });
    const current = await requireSummary(routineId, user.workspaceId);
    if (!isPendingProposal(current)) {
      throw new ServiceError("conflict", "Routine is not waiting for approval");
    }
    const now = clock.now();
    const approved = await db
      .update(triggers)
      .set({
        approvedAt: now.toISOString(),
        consecutiveErrors: 0,
        disabledAt: null,
        lastError: null,
        nextRunAt: nextSlot(current.cron, current.timezone, now),
      })
      .where(
        and(
          eq(triggers.id, routineId),
          eq(triggers.workspaceId, user.workspaceId),
          isNull(triggers.approvedAt),
          isNull(triggers.revokedAt)
        )
      )
      .returning({ id: triggers.id });
    if (approved.length === 0) {
      throw new ServiceError("conflict", "Routine is not waiting for approval");
    }
    await recordChange(events, user, {
      agentId: current.agentId,
      change: "approved",
      kind: ROUTINE_KIND,
      name: current.name,
      triggerId: routineId,
      workspaceId: user.workspaceId,
    });
    return await requireSummary(routineId, user.workspaceId);
  };

  /**
   * Pauses a routine, or resumes it. Resuming clears the error count and
   * picks the next slot after now, so a long pause does not fire at once.
   * Resuming a proposal is approving it. A run can only pause.
   */
  const setEnabled = async (
    principal: Principal,
    input: RoutineSetEnabledInput
  ): Promise<RoutineSummary> => {
    const actor = requireWriter(principal, ENABLE_ACTION);
    const { enabled, routineId } = routineSetEnabledInputSchema.parse(input);
    authorize(actor, ENABLE_ACTION, {
      id: routineId,
      kind: ROUTINE_KIND,
      workspaceId: actor.workspaceId,
    });
    if (actor.kind === "run" && enabled) {
      throw new ForbiddenError(ENABLE_ACTION);
    }
    const current = await requireSummary(routineId, actor.workspaceId);
    requireOwnAgent(actor, current.agentId, ENABLE_ACTION);
    if (enabled && isPendingProposal(current)) {
      return await approve(actor, routineId);
    }
    const now = clock.now();
    const changes = enabled
      ? {
          consecutiveErrors: 0,
          disabledAt: null,
          lastError: null,
          nextRunAt: nextSlot(current.cron, current.timezone, now),
        }
      : { disabledAt: now.toISOString() };
    await db
      .update(triggers)
      .set(changes)
      .where(
        and(
          eq(triggers.id, routineId),
          eq(triggers.workspaceId, actor.workspaceId)
        )
      );
    return await requireSummary(routineId, actor.workspaceId);
  };

  /**
   * Removes a routine. The row stays, revoked, so the log can still name it.
   * A run removes only a routine its agent proposed.
   */
  const remove = async (
    principal: Principal,
    routineId: string
  ): Promise<void> => {
    const actor = requireWriter(principal, REMOVE_ACTION);
    authorize(actor, REMOVE_ACTION, {
      id: routineId,
      kind: ROUTINE_KIND,
      workspaceId: actor.workspaceId,
    });
    const current = await requireSummary(routineId, actor.workspaceId);
    if (actor.kind === "run" && current.proposedByAgentId !== actor.agentId) {
      throw new ForbiddenError(REMOVE_ACTION);
    }
    const removed = await db
      .update(triggers)
      .set({ revokedAt: clock.now().toISOString() })
      .where(
        and(
          eq(triggers.id, routineId),
          eq(triggers.workspaceId, actor.workspaceId),
          isNull(triggers.revokedAt)
        )
      )
      .returning({ id: triggers.id });
    if (removed.length > 0) {
      await recordChange(events, actor, {
        agentId: current.agentId,
        change: "deleted",
        kind: ROUTINE_KIND,
        name: current.name,
        triggerId: routineId,
        workspaceId: actor.workspaceId,
      });
    }
  };

  /** Rejects a proposal: the routine is removed and the log says it was rejected. */
  const reject = async (
    principal: Principal,
    routineId: string
  ): Promise<void> => {
    const user = requireApprover(principal, REJECT_ACTION);
    authorize(user, CREATE_ACTION, {
      id: routineId,
      kind: ROUTINE_KIND,
      workspaceId: user.workspaceId,
    });
    const current = await requireSummary(routineId, user.workspaceId);
    if (!isPendingProposal(current)) {
      throw new ServiceError("conflict", "Routine is not waiting for approval");
    }
    const rejected = await db
      .update(triggers)
      .set({ revokedAt: clock.now().toISOString() })
      .where(
        and(
          eq(triggers.id, routineId),
          eq(triggers.workspaceId, user.workspaceId),
          isNull(triggers.approvedAt),
          isNull(triggers.revokedAt)
        )
      )
      .returning({ id: triggers.id });
    if (rejected.length === 0) {
      throw new ServiceError("conflict", "Routine is not waiting for approval");
    }
    await recordChange(events, user, {
      agentId: current.agentId,
      change: "rejected",
      kind: ROUTINE_KIND,
      name: current.name,
      triggerId: routineId,
      workspaceId: user.workspaceId,
    });
  };

  type DueRow = typeof triggers.$inferSelect;

  /** Counts a failed attempt, only while the slot is still the one that failed. */
  const recordFailure = async (row: DueRow, due: string, message: string) => {
    const errors = sql`${triggers.consecutiveErrors} + 1`;
    await db
      .update(triggers)
      .set({
        consecutiveErrors: errors,
        disabledAt: sql`CASE WHEN ${errors} >= ${ROUTINE_ERROR_LIMIT} THEN ${clock.now().toISOString()} ELSE ${triggers.disabledAt} END`,
        lastError: message,
      })
      .where(and(eq(triggers.id, row.id), eq(triggers.nextRunAt, due)));
  };

  /** One due routine: the run and the move to the next slot, written together. */
  const fireOne = async (row: DueRow, due: string, result: FireDueResult) => {
    const now = clock.now();
    const nextRunAt = nextSlot(row.cron ?? "", row.timezone ?? "", now);
    const advance = (fields: { lastFiredAt?: string }) =>
      db
        .update(triggers)
        .set({ ...fields, nextRunAt })
        .where(and(eq(triggers.id, row.id), eq(triggers.nextRunAt, due)));
    // The id of the run this call tries to write. A started run with another
    // id is the one a duplicate slot handed back.
    let attempted = "";
    const started = await runsService.startRun(
      {
        agentId: row.agentId,
        kind: "trigger",
        triggerId: row.id,
        workspaceId: row.workspaceId,
      },
      {
        agentId: row.agentId,
        input: { text: row.prompt ?? "" },
        requestId: `trigger:${row.id}:${due}`,
        session: { origin: "trigger" },
      },
      {
        alongside: ({ runId }) => {
          attempted = runId;
          return [advance({ lastFiredAt: now.toISOString() })];
        },
      }
    );
    if (started.runId === attempted) {
      await events.append({
        actor: { id: row.id, kind: "trigger" },
        agentId: row.agentId,
        payload: { requestId: due, triggerId: row.id },
        runId: started.runId,
        sessionId: started.sessionId,
        type: "trigger.fired",
        workspaceId: row.workspaceId,
      });
      result.fired.push(started.runId);
      return;
    }
    // Another tick wrote this slot. Its write moved `next_run_at`, unless that
    // write was undone since; moving it here is a no-op in the usual case.
    await advance({});
    result.readBack.push(started.runId);
  };

  /**
   * The minute tick's firing job. Each due routine, oldest slot first, gets
   * one run. A routine that fails is counted and the others still run.
   */
  const fireDue = async (principal: Principal): Promise<FireDueResult> => {
    requireSystem(principal, FIRE_ACTION);
    const result: FireDueResult = { failed: [], fired: [], readBack: [] };
    if (allowedOrgIds.length === 0) {
      return result;
    }
    const due = (
      await db
        .select({ routine: triggers })
        .from(triggers)
        .innerJoin(workspaces, eq(workspaces.id, triggers.workspaceId))
        .where(
          and(
            inArray(workspaces.clerkOrgId, [...allowedOrgIds]),
            eq(triggers.kind, ROUTINE_KIND),
            isNull(triggers.revokedAt),
            isNull(triggers.disabledAt),
            isNotNull(triggers.nextRunAt),
            lte(triggers.nextRunAt, clock.now().toISOString())
          )
        )
        .orderBy(asc(triggers.nextRunAt))
        .limit(TICK_BATCH)
    ).map(({ routine }) => routine);
    for (const row of due) {
      const slot = row.nextRunAt ?? "";
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one routine at a time keeps a failure to that routine
        await fireOne(row, slot, result);
      } catch (error) {
        const message = messageOf(error);
        result.failed.push({ message, routineId: row.id });
        try {
          await recordFailure(row, slot, message);
        } catch {
          // The failure is in the result already; the next tick counts again.
        }
      }
    }
    return result;
  };

  /**
   * The minute tick's judging job. Each routine's runs after `settled_run_id`
   * are counted in order, up to the first one that has not ended: `done`
   * clears the error count, `failed` and `interrupted` add one (the fifth
   * switches the routine off), `cancelled` counts for nothing. Each routine
   * is read on its own, so one with a backlog cannot hold up the others. One
   * guarded update per routine moves the count and `settled_run_id` together,
   * so a run is counted once however the jobs overlap, and `disabled_at` is
   * decided in SQL so a concurrent pause or resume is never undone.
   */
  const settleRuns = async (principal: Principal): Promise<SettleResult> => {
    requireSystem(principal, SETTLE_ACTION);
    // Routines whose next run to count, the first one after the watermark,
    // has ended. One behind a run that has not ended is left out, however
    // many later runs ended, so it cannot take a slot from the others.
    const later = alias(runs, "later");
    const firstUnjudged = db
      .select({ id: min(later.id) })
      .from(later)
      .where(
        and(
          eq(later.actorId, triggers.id),
          eq(later.actorKind, "trigger"),
          gt(later.id, sql`coalesce(${triggers.settledRunId}, '')`)
        )
      );
    const candidates = await db
      .select({
        disabledAt: triggers.disabledAt,
        errors: triggers.consecutiveErrors,
        id: triggers.id,
        lastError: triggers.lastError,
        settledRunId: triggers.settledRunId,
      })
      .from(triggers)
      .where(
        and(
          eq(triggers.kind, ROUTINE_KIND),
          isNull(triggers.revokedAt),
          exists(
            db
              .select({ one: sql`1` })
              .from(runs)
              .where(
                and(
                  eq(runs.actorId, triggers.id),
                  eq(runs.actorKind, "trigger"),
                  inArray(runs.status, ENDED),
                  eq(runs.id, firstUnjudged)
                )
              )
          )
        )
      )
      // The routine that has waited longest goes first. Run ids sort by time,
      // so with more candidates than the limit nobody waits for ever.
      .orderBy(asc(sql`${firstUnjudged}`), asc(triggers.id))
      .limit(TICK_BATCH);
    let settled = 0;
    for (const routine of candidates) {
      // biome-ignore lint/performance/noAwaitInLoops: one routine at a time, each with its own run limit
      const routineRuns = await db
        .select({
          runError: runs.error,
          runId: runs.id,
          status: runs.status,
        })
        .from(runs)
        .where(
          and(
            eq(runs.actorId, routine.id),
            eq(runs.actorKind, "trigger"),
            gt(runs.id, routine.settledRunId ?? "")
          )
        )
        .orderBy(asc(runs.id))
        .limit(SETTLE_RUNS_PER_ROUTINE);
      const verdict = judge(routineRuns, routine);
      if (verdict === null) {
        continue;
      }
      const now = clock.now().toISOString();
      const switchOff = verdict.errors >= ROUTINE_ERROR_LIMIT ? now : null;
      const updated = await db
        .update(triggers)
        .set({
          consecutiveErrors: verdict.errors,
          // Decided by the row as it is now, so a pause or resume that landed
          // since the read stays.
          disabledAt: sql`coalesce(${triggers.disabledAt}, ${switchOff})`,
          lastError: verdict.lastError,
          settledRunId: verdict.settledRunId,
        })
        .where(
          and(
            eq(triggers.id, routine.id),
            eq(triggers.consecutiveErrors, routine.errors),
            routine.settledRunId === null
              ? isNull(triggers.settledRunId)
              : eq(triggers.settledRunId, routine.settledRunId)
          )
        )
        .returning({ id: triggers.id });
      settled += updated.length;
    }
    return { settled };
  };

  return {
    approve,
    create,
    fireDue,
    list,
    reject,
    remove,
    setEnabled,
    settleRuns,
  };
};

export type RoutinesService = ReturnType<typeof createRoutinesService>;
