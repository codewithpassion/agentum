/**
 * Routines: a `triggers` row of kind `routine` that starts one agent on a cron
 * schedule. A signed-in user makes, pauses and removes them. The minute tick
 * calls `fireDue` and `settleRuns`.
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
 * off (`disabled_at`); a `done` run resets the count.
 */
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { runs } from "@repo/db/schema/runs";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import { ROUTINE_ERROR_LIMIT } from "@repo/db/shared";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { ulid } from "ulidx";
import { z } from "zod";
import { findAgent } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
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
const ERROR_MESSAGE_MAX = 500;

const ROUTINE_KIND = "routine";
const CREATE_ACTION = "routines.create";
const LIST_ACTION = "routines.list";
const ENABLE_ACTION = "routines.setEnabled";
const REMOVE_ACTION = "routines.remove";
const FIRE_ACTION = "routines.fire";
const SETTLE_ACTION = "routines.settle";

type UserPrincipal = Extract<Principal, { kind: "user" }>;

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
  timezone: sql<string>`coalesce(${triggers.timezone}, '')`,
};

const requireUser = (principal: Principal, action: string): UserPrincipal => {
  if (principal.kind !== "user" || principal.via !== "session") {
    throw new ForbiddenError(action);
  }
  return principal;
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

  /** A routine for one agent, first due at the next slot after now. */
  const create = async (
    principal: Principal,
    input: RoutineCreateInput
  ): Promise<RoutineSummary> => {
    const user = requireUser(principal, CREATE_ACTION);
    const parsed = routineCreateInputSchema.parse(input);
    authorize(user, CREATE_ACTION, {
      kind: ROUTINE_KIND,
      workspaceId: user.workspaceId,
    });
    const cronError = validateCron(parsed.cron);
    if (cronError !== null) {
      throw new ServiceError("invalid", cronError);
    }
    const timezone =
      parsed.timezone ?? (await workspaceTimezone(user.workspaceId));
    if (!isValidTimeZone(timezone)) {
      throw new ServiceError("invalid", `Unknown timezone ${timezone}`);
    }
    const agent = await findAgent(db, {
      id: parsed.agentId,
      workspaceId: user.workspaceId,
    });
    if (agent?.status !== "active") {
      throw new ServiceError("not_found", "Agent not found");
    }
    const now = clock.now();
    const nextRunAt = nextSlot(parsed.cron, timezone, now);
    if (nextRunAt === null) {
      throw new ServiceError("invalid", "That schedule never fires");
    }
    const id = `rtn_${ulid(now.getTime())}`;
    await db.insert(triggers).values({
      agentId: agent.id,
      createdAt: now.toISOString(),
      createdBy: user.userId,
      cron: parsed.cron,
      id,
      kind: ROUTINE_KIND,
      name: parsed.name,
      nextRunAt,
      prompt: parsed.prompt,
      timezone,
      workspaceId: user.workspaceId,
    });
    return await requireSummary(id, user.workspaceId);
  };

  /** The workspace's routines, newest first. Removed ones are left out. */
  const list = async (
    principal: Principal,
    input: RoutineListInput = {}
  ): Promise<RoutineSummary[]> => {
    const user = requireUser(principal, LIST_ACTION);
    const { agentId } = routineListInputSchema.parse(input);
    authorize(user, LIST_ACTION, {
      kind: ROUTINE_KIND,
      workspaceId: user.workspaceId,
    });
    return await db
      .select(summaryColumns)
      .from(triggers)
      .innerJoin(agents, eq(agents.id, triggers.agentId))
      .where(
        and(
          eq(triggers.workspaceId, user.workspaceId),
          eq(triggers.kind, ROUTINE_KIND),
          isNull(triggers.revokedAt),
          agentId === undefined ? undefined : eq(triggers.agentId, agentId)
        )
      )
      .orderBy(desc(triggers.createdAt), desc(triggers.id));
  };

  /**
   * Pauses a routine, or resumes it. Resuming clears the error count and
   * picks the next slot after now, so a long pause does not fire at once.
   */
  const setEnabled = async (
    principal: Principal,
    input: RoutineSetEnabledInput
  ): Promise<RoutineSummary> => {
    const user = requireUser(principal, ENABLE_ACTION);
    const { enabled, routineId } = routineSetEnabledInputSchema.parse(input);
    authorize(user, ENABLE_ACTION, {
      id: routineId,
      kind: ROUTINE_KIND,
      workspaceId: user.workspaceId,
    });
    const current = await requireSummary(routineId, user.workspaceId);
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
          eq(triggers.workspaceId, user.workspaceId)
        )
      );
    return await requireSummary(routineId, user.workspaceId);
  };

  /** Removes a routine. The row stays, revoked, so the log can still name it. */
  const remove = async (
    principal: Principal,
    routineId: string
  ): Promise<void> => {
    const user = requireUser(principal, REMOVE_ACTION);
    authorize(user, REMOVE_ACTION, {
      id: routineId,
      kind: ROUTINE_KIND,
      workspaceId: user.workspaceId,
    });
    await requireSummary(routineId, user.workspaceId);
    await db
      .update(triggers)
      .set({ revokedAt: clock.now().toISOString() })
      .where(
        and(
          eq(triggers.id, routineId),
          eq(triggers.workspaceId, user.workspaceId),
          isNull(triggers.revokedAt)
        )
      );
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
    const advance = (runId: string, fields: { lastFiredAt?: string }) =>
      db
        .update(triggers)
        // Keep a run still waiting to be judged; `settleRuns` clears it.
        .set({
          ...fields,
          lastRunId: sql`coalesce(${triggers.lastRunId}, ${runId})`,
          nextRunAt,
        })
        .where(and(eq(triggers.id, row.id), eq(triggers.nextRunAt, due)));
    const requestId = `trigger:${row.id}:${due}`;
    const started = await runsService.startRunWith(
      {
        agentId: row.agentId,
        kind: "trigger",
        triggerId: row.id,
        workspaceId: row.workspaceId,
      },
      {
        agentId: row.agentId,
        input: { text: row.prompt ?? "" },
        requestId,
        session: { origin: "trigger" },
      },
      ({ runId }) => [advance(runId, { lastFiredAt: now.toISOString() })]
    );
    if (started.inserted) {
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
    await advance(started.runId, {});
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
   * The minute tick's judging job. A routine whose last run ended is updated
   * once: `done` clears the error count, `failed` and `interrupted` add one
   * (the fifth switches the routine off), `cancelled` counts for nothing.
   */
  const settleRuns = async (principal: Principal): Promise<SettleResult> => {
    requireSystem(principal, SETTLE_ACTION);
    const ended = await db
      .select({
        error: runs.error,
        id: triggers.id,
        runId: runs.id,
        status: runs.status,
      })
      .from(triggers)
      .innerJoin(runs, eq(runs.id, triggers.lastRunId))
      .where(
        and(
          eq(triggers.kind, ROUTINE_KIND),
          inArray(runs.status, ["done", "failed", "interrupted", "cancelled"])
        )
      )
      .limit(TICK_BATCH);
    let settled = 0;
    for (const row of ended) {
      const guard = and(
        eq(triggers.id, row.id),
        eq(triggers.lastRunId, row.runId)
      );
      const errors = sql`${triggers.consecutiveErrors} + 1`;
      let changes: SQLiteUpdateSetSource<typeof triggers> = { lastRunId: null };
      if (row.status === "done") {
        changes = { consecutiveErrors: 0, lastError: null, lastRunId: null };
      } else if (row.status !== "cancelled") {
        changes = {
          consecutiveErrors: errors,
          disabledAt: sql`CASE WHEN ${errors} >= ${ROUTINE_ERROR_LIMIT} THEN ${clock.now().toISOString()} ELSE ${triggers.disabledAt} END`,
          lastError: (row.error ?? `Run ${row.status}`).slice(
            0,
            ERROR_MESSAGE_MAX
          ),
          lastRunId: null,
        };
      }
      // biome-ignore lint/performance/noAwaitInLoops: each update is guarded by its own run id
      const updated = await db
        .update(triggers)
        .set(changes)
        .where(guard)
        .returning({ id: triggers.id });
      settled += updated.length;
    }
    return { settled };
  };

  return { create, fireDue, list, remove, setEnabled, settleRuns };
};

export type RoutinesService = ReturnType<typeof createRoutinesService>;
